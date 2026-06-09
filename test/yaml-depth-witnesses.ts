// yaml-depth-witnesses.ts — a RAW-SCOPE regression gate for the flat YAML TextMate highlighter's
// depth/position sites. It exists because the scope-gap metric reported `monogramWrong=0` while real
// bugs (monogram#23/#24) sat in plain sight: that metric is corpus-bound (the witnesses aren't in
// yaml-test-suite) AND excludes lexical-floor roles (a `-` mis-painted as string is invisible because
// `punctuation` is floor-excluded and the `b` beside it grades correct). So a "0 wrong" headline never
// meant "no bug" — only "no bug my metric can see".
//
// THEOREM behind the cases: where a construct's correct scope depends on cross-line STATE the parser
// keeps in a stack (depth), and the derived TextMate grammar is flat (no stack), the set of inputs
// where they disagree is provably NON-EMPTY. So we don't wait for a corpus to surface these — we
// CONSTRUCT one witness per state field of the derived YAML scanner (indent stack, flow depth,
// block-scalar region, document-marker position, node-property lead) and assert the RAW inner scope at
// the position the depth decides. This is oracle-independent (a fixed expected scope) and floor-blind
// (it checks the punctuation/string class directly), so neither blind spot can hide a regression.
//
// Run (bare node): node test/yaml-depth-witnesses.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const bin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const reg = new Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
  loadGrammar: async (sn: string) => sn === 'source.yaml' ? parseRawGrammar(readFileSync('yaml.tmLanguage.json', 'utf8'), 'y.json') : null,
});
const grammar = (await reg.loadGrammar('source.yaml'))!;

interface Tok { start: number; end: number; scopes: string[] }
function tokenize(text: string): Tok[] {
  const toks: Tok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = grammar.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}
function scopeAt(toks: Tok[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const s = ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
  return s.length ? s[s.length - 1] : '(none)';
}
// Locate the byte offset of `find` in `input` (optionally the n-th occurrence, 0-based).
function locate(input: string, find: string, nth = 0): number {
  let i = -1; for (let k = 0; k <= nth; k++) { i = input.indexOf(find, i + 1); if (i < 0) throw new Error(`witness focus not found: ${JSON.stringify(find)}#${nth}`); }
  return i;
}

interface Case {
  state: string;          // the scanner state field this witness probes
  input: string;
  find: string; nth?: number; off?: number;   // focus = nth occurrence of `find`, plus `off` chars
  want?: string;          // inner scope MUST start with this
  notWant?: string;       // inner scope MUST NOT start with this
  note: string;
  knownBug?: boolean;     // a depth site not yet fixed in the flat derivation — tracked, not asserted
}

const cases: Case[] = [
  // ── document-marker POSITION (monogram#23): a marker is column-0-only; a value-leading `---`/`...`
  //    is string content. Fixed by anchoring DocStart/DocEnd with start() (yaml.ts) + the lexer m-flag.
  { state: 'doc-marker position', input: 'note: --- not a marker\n', find: '---', want: 'string',
    notWant: 'entity.other.document', note: 'value-leading `---` is string, not document.begin' },
  { state: 'doc-marker position', input: 'x: ... bar\n', find: '...', want: 'string',
    notWant: 'entity.other.document', note: 'value-leading `...` is string, not document.end' },
  { state: 'doc-marker position', input: '- --- x\n', find: '---', want: 'string',
    notWant: 'entity.other.document', note: 'sequence-item value-leading `---` is string' },
  // a LEGITIMATE column-0 marker must still scope as document structure (the fix must not over-correct)
  { state: 'doc-marker position', input: '---\nkey: value\n', find: '---', want: 'entity.other.document',
    note: 'a real column-0 `---` is still a document marker' },

  // ── block-scalar REGION: inside `|`/`>` the body is literal text — `#`/`-` are NOT comment/indicator.
  //    Handled by the block-scalar begin/end region (a depth mechanism the flat grammar DOES carry).
  { state: 'block-scalar region', input: 'a: |\n  # literal\n  x\n', find: '# literal', want: 'string',
    notWant: 'comment', note: 'inside a block scalar `#` is text, not a comment' },
  { state: 'block-scalar region', input: 'a: |\n  - literal\n  x\n', find: '- literal', want: 'string',
    notWant: 'punctuation', note: 'inside a block scalar `-` is text, not a sequence indicator' },

  // ── flow DEPTH: outside flow, `,` and an inner `:` are plain-scalar content (block `{k:"a,b"}`).
  { state: 'flow depth', input: 'k: a,b\n', find: ',b', want: 'string',
    notWant: 'punctuation.separator', note: 'block plain scalar — `,` is content, not a flow separator' },

  // ── indent STACK (monogram#24): a nested compact sequence sibling vs a plain-scalar fold. The `-` on
  //    the indented line is a sequence indicator when a sequence is established at that column, but
  //    folds into the preceding plain scalar otherwise — same surface, opposite answer, decided only by
  //    the indent stack a flat grammar lacks. FIXED by gen-tm §2c: a column-anchored COMPACT
  //    block-sequence region whose `\G`-anchored `while` (re-anchored each line by meta.stream) reclaims
  //    the inner sibling `- ` at the inner indicator's column before the §2a′ fold can swallow it.
  { state: 'indent stack (sibling vs fold)', input: '- - a\n  - b\n- c\n', find: '- b', off: 0, want: 'punctuation',
    notWant: 'string', note: 'inner-sequence sibling `-` is punctuation, not folded into a plain scalar' },
  // the counter-proof — SAME indented `- b` line, but here it MUST fold (no sequence at column 2). This
  // is asserted (not a known bug): the eventual #24 fix must keep this one folding.
  { state: 'indent stack (counter-proof)', input: 'x: hello\n  - b\n', find: '- b', want: 'string',
    note: 'plain-scalar continuation — `- b` folds (no sequence established at column 2)' },
  // a `-`-led continuation indented STRICTLY DEEPER than the inner indicator (`- - a\n   - b` =
  // `[["a - b"]]` — the deeper `- b` folds into the scalar `a`) folds its `-` as plain content. Resolved by
  // §2c pinning the inner column portably (`\1\2 \4`: outer indent + the dash's own column + the captured
  // indicator run) so the `while` reclaims ONLY a same-column sibling, with a deeper line folded by the
  // body's #block-fold rule. A deeper-NESTED sibling (`- - - a\n    - b`) still scopes `punctuation` (its
  // own level's region reclaims it) — distinguished by the rule-stack, not a variable-length lookbehind.
  { state: 'indent stack (deeper-irregular fold)', input: '- - a\n   - b\n', find: '- b', want: 'string',
    notWant: 'punctuation', note: 'deeper-than-inner `- b` should fold into the plain scalar' },

  // ── indent STACK (NON-FIRST-ITEM compact nest, the monogram#24 generalization): a compact nested
  //    sequence opened by a SECOND-or-later sibling of the outer sequence (`  - - b`, `  - k:`, `  - ? k`),
  //    on a CONTINUATION line. The deepest sibling `-` must stay `punctuation` (the parser assigns `$punct`,
  //    official scopes `punctuation.definition.block.sequence.item`), but the §2c fix that closed only the
  //    FIRST-item case let a sibling-opened nest ESCAPE the region (the outer `while`'s consuming reclaim ate
  //    the continuation line's indent before the body ran, so the nested region opened mid-line with an
  //    empty `( *+)` and reconstructed its sibling column too shallow → the deeper sibling fell to the fold,
  //    painted string). FIXED by the §2c `while` arm 0 (a compact sibling is reclaimed ZERO-WIDTH so the body
  //    re-dispatches it from line start, opening a column-correct nested #block-sequence) + #block-value (a
  //    `key:`-EOL / `? k`+`:` value block dispatches its deeper sequence instead of folding it). These are
  //    LOCKED (asserted, not knownBug) — reverting either re-paints the deepest `-` string.
  { state: 'indent stack (non-first-item compact nest)', input: '- - a\n  - - b\n    - c\n', find: '- c', want: 'punctuation',
    notWant: 'string', note: 'deepest sibling `- c` of a sibling-opened compact nest is punctuation, not folded' },
  { state: 'indent stack (non-first-item compact nest)', input: '- - a\n  - - b\n    - c\n    - d\n', find: '- d', want: 'punctuation',
    notWant: 'string', note: 'a SECOND deep sibling `- d` is punctuation (the region reclaims every sibling, not just the first)' },
  { state: 'indent stack (non-first-item compact nest)', input: '- - x\n  - - y\n    - z\n  - w\n', find: '- z', want: 'punctuation',
    notWant: 'string', note: 'inner deep sibling `- z` is punctuation even when an OUTER sibling `- w` resumes after it' },
  // the OUTER sibling that resumes after the inner nest must ALSO stay punctuation (the outer region survived
  // the inner nest — the inner `while` released at the dedent and the outer reclaimed `- w`).
  { state: 'indent stack (non-first-item compact nest)', input: '- - x\n  - - y\n    - z\n  - w\n', find: '- w', want: 'punctuation',
    notWant: 'string', note: 'the outer sibling `- w` resuming after the inner nest is still punctuation' },
  // the inner block opened by a sibling is a MAPPING-VALUE sequence (`  - k:` then `    - x`) — its deeper
  // sequence items dispatch (via #block-value) instead of folding into a string.
  { state: 'indent stack (non-first-item map-value nest)', input: '- - a\n  - k:\n    - x\n    - y\n', find: '- x', want: 'punctuation',
    notWant: 'string', note: 'a sibling item `- k:` whose value is a sequence → `- x` is a sequence indicator, not folded' },
  { state: 'indent stack (non-first-item map-value nest)', input: '- - a\n  - k:\n    - x\n    - y\n', find: '- y', want: 'punctuation',
    notWant: 'string', note: 'every item of the mapping-value sequence stays punctuation' },
  // the inner block opened by a sibling is an EXPLICIT-KEY value sequence (`  - ? k\n    :\n      - x`).
  { state: 'indent stack (non-first-item explicit-key nest)', input: '- - a\n  - ? k\n    :\n      - x\n      - y\n', find: '- x', want: 'punctuation',
    notWant: 'string', note: 'a sibling explicit-key item whose value is a sequence → `- x` is a sequence indicator, not folded' },
  // counter-proof: the §2c #block-value must NOT fold a plain-scalar value continuation — `- k:\n    v\n    cont`
  // = `{k: "v cont"}`, so `cont` STILL folds into the value scalar `v` (string), even inside the value block.
  { state: 'indent stack (value-block plain continuation)', input: '- - a\n  - k:\n    v\n    cont\n', find: 'cont', want: 'string',
    notWant: 'punctuation', note: 'a plain-scalar value continuation `cont` folds into `v`, not dispatched' },

  // ── indent STACK (explicit-key VALUE position): `? k:\n  - x` is `{ {k:[x]}: null }` — the EXPLICIT
  //    KEY is the mapping `{k:[x]}`, so `k:`'s value is the block sequence `[x]` and the `- ` at column 2
  //    is a sequence indicator (punctuation), the `? ` likewise a map-key indicator. This is the depth-bug
  //    CLASS closed by the value-position transform (valuePositions): `? k:` is a `?`-led key whose
  //    trailing `:` opens a VALUE-POSITION, so the explicit-key / plain folds YIELD (their value-position
  //    guard `(?!key)` fails on `k:`) and the indented value-block routes to the shared dispatch — the
  //    indicator is scoped structurally, exactly as at the plain block-mapping value `k:\n  - x` (which
  //    always worked). Before the transform both lines were swallowed (the explicit-key fold scoped them
  //    `entity.name.tag`, then the plain fold `string.unquoted`) — neither structural. LOCKED.
  { state: 'indent stack (explicit-key value)', input: '? k:\n  - x\n', find: '- x', want: 'punctuation',
    notWant: 'entity.name.tag', note: 'explicit-key value `- x` is a sequence indicator, not a folded key' },
  { state: 'indent stack (explicit-key value)', input: '? k:\n  ? x\n', find: '? x', want: 'punctuation',
    notWant: 'entity.name.tag', note: 'explicit-key value `? x` is a map-key indicator, not a folded key' },
  // counter-proof for the value-position guard: a BARE explicit key (no trailing `:`) MUST still fold as
  // the KEY (`? a\n  b` = key "a b"), and an explicit key with an INLINE value (`? k: hello\n    more`)
  // folds `more` as the VALUE (string.unquoted), NOT the key — the fold yields the colon to a value site.
  { state: 'indent stack (explicit-key bare-fold)', input: '? a\n  b\n', find: 'b', want: 'entity.name.tag',
    note: 'a bare explicit key `? a\\n  b` folds into the KEY "a b"' },
  { state: 'indent stack (explicit-key inline-value)', input: '? k: hello\n    more\n', find: 'more', want: 'string',
    notWant: 'entity.name.tag', note: 'an explicit key inline value folds the continuation as the VALUE, not the key' },
];

let pass = 0, knownBugs = 0, regressions = 0;
for (const c of cases) {
  const toks = tokenize(c.input);
  const pos = locate(c.input, c.find, c.nth) + (c.off ?? 0);
  const got = scopeAt(toks, pos).replace(/\.yaml$/, '');
  const okWant = c.want ? got.startsWith(c.want) : true;
  const okNot = c.notWant ? !got.startsWith(c.notWant) : true;
  const ok = okWant && okNot;
  const expectStr = [c.want && `want ${c.want}*`, c.notWant && `not ${c.notWant}*`].filter(Boolean).join(', ');
  if (c.knownBug) {
    knownBugs++;
    console.log(`  ${ok ? '✓ FIXED' : '· known'} [${c.state}] ${JSON.stringify(c.input)} @«${c.find}» → «${got}» (${expectStr})`);
    if (ok) console.log(`           ↑ this known bug now PASSES — flip knownBug:false to lock it in.`);
  } else if (ok) {
    pass++;
    console.log(`  ✓ ok    [${c.state}] @«${c.find}» → «${got}»`);
  } else {
    regressions++;
    console.log(`  ✗ FAIL  [${c.state}] ${JSON.stringify(c.input)} @«${c.find}» → «${got}» — expected ${expectStr}`);
    console.log(`           ${c.note}`);
  }
}
console.log(`\n  ${pass} pass · ${knownBugs} known-bug (depth sites not yet derived) · ${regressions} regression`);
if (regressions > 0) { console.error('\nDEPTH WITNESS REGRESSION — a flat-highlighter depth/position site broke.'); process.exit(1); }
