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
  //    the indent stack a flat grammar lacks. KNOWN BUG until gen-tm derives indent-tracking regions.
  { state: 'indent stack (sibling vs fold)', input: '- - a\n  - b\n- c\n', find: '- b', off: 0, want: 'punctuation',
    notWant: 'string', note: 'inner-sequence sibling `-` is punctuation, not folded into a plain scalar', knownBug: true },
  // the counter-proof — SAME indented `- b` line, but here it MUST fold (no sequence at column 2). This
  // is asserted (not a known bug): the eventual #24 fix must keep this one folding.
  { state: 'indent stack (counter-proof)', input: 'x: hello\n  - b\n', find: '- b', want: 'string',
    note: 'plain-scalar continuation — `- b` folds (no sequence established at column 2)' },
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
