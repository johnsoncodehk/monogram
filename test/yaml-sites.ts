// yaml-sites.ts — the raw-scope locks of the flat YAML TextMate highlighter's depth / position sites.
//
// Where a construct's correct scope depends on cross-line STATE the parser keeps on a stack (indent
// depth, flow depth, block-scalar floor, document-marker position) and the derived TextMate grammar is
// flat, the set of inputs where they disagree is provably NON-EMPTY. So the sites are CONSTRUCTED, not
// waited for in a corpus, and each section asserts the RAW inner scope at the position the depth
// decides: oracle-independent (a fixed expected scope, or the `yaml` package's CST), and floor-blind
// (it checks the punctuation / string class directly; the role-graded scope-gap metric once reported
// 0 wrong while monogram#23/#24 sat in plain sight). One section per bug class:
//   1. witnesses       one hand-built witness per scanner state field (monogram#23/#24 and generalisations)
//   2. depth-sites     every declared indicator × every IR-derived value position (valuePositions) is punctuation
//   3. flow-sites      a flow opener MID plain scalar, in every block node context, is content
//   4. compact-nest    every sequence indicator of a non-first-item compact nest is punctuation
//   5. deepest-sibling an inline `- - … a` header + a sibling at every column, d = 1..12, both
//                      directions against the `yaml` CST (`seq-item-ind`)
//   6. blockscalar     a block scalar's content floor at compact depth d = 1..12 (`|2`, `|3`, auto `|`)
// The official RedCMD grammar (/tmp/redcmd-yaml, present in readme-bench) is shown for context on a
// failure when present; pass / fail is self-contained.
//
// Run (bare node): node test/yaml-sites.ts [path/to/yaml.tmLanguage.json]   (default: the committed one)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import YAML from 'yaml';
import grammar from '../yaml.ts';
import { valuePositions } from '../src/editor/highlight-facts.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
function load(files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar('source.yaml');
}
const grammarPath = process.argv[2] ?? 'yaml.tmLanguage.json';
const tm = (await load({ 'source.yaml': grammarPath }))!;
const SYN = '/tmp/redcmd-yaml/syntaxes';
const official = existsSync(join(SYN, 'yaml.tmLanguage.json')) ? (await load({
  'source.yaml': join(SYN, 'yaml.tmLanguage.json'),
  'source.yaml.1.2': join(SYN, 'yaml-1.2.tmLanguage.json'), 'source.yaml.1.1': join(SYN, 'yaml-1.1.tmLanguage.json'),
  'source.yaml.1.0': join(SYN, 'yaml-1.0.tmLanguage.json'), 'source.yaml.1.3': join(SYN, 'yaml-1.3.tmLanguage.json'),
  'source.yaml.embedded': join(SYN, 'yaml-embedded.tmLanguage.json'),
}))! : null;

interface Tok { start: number; end: number; scopes: string[] }
function tokenize(g: vsctm.IGrammar, text: string): Tok[] {
  const toks: Tok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = g.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}
/** The innermost scope (without its `.yaml` suffix) of the token covering `pos`, `(none)` if none does. */
function innerAt(toks: Tok[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const s = ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
  return (s.length ? s[s.length - 1] : '(none)').replace(/\.yaml$/, '');
}
const offsetOf = (src: string, line: number, col: number) => src.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
const valid = (s: string): boolean => { try { YAML.parse(s); return true; } catch { return false; } };
const oracle = (input: string, pos: number) => official ? `  O→${innerAt(tokenize(official, input), pos)}` : '';

const results: { section: string; checked: number; wrong: string[] }[] = [];
function section(name: string, run: (fail: (what: string) => void) => number) {
  const wrong: string[] = [];
  const checked = run((what) => { wrong.push(what); console.log(`  ✗ [${name}] ${what}`); });
  results.push({ section: name, checked, wrong });
}

// ── 1. witnesses: one per state field of the derived YAML scanner ─────────────────────────────
interface Case {
  state: string;          // the scanner state field this witness probes
  input: string;
  find: string; nth?: number; off?: number;   // focus = nth occurrence of `find`, plus `off` chars
  want?: string;          // inner scope MUST start with this
  notWant?: string;       // inner scope MUST NOT start with this
  note: string;
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
  //    the indent stack a flat grammar lacks. FIXED by gen-textmate §2c: a column-anchored COMPACT
  //    block-sequence region whose `\G`-anchored `while` (re-anchored each line by meta.stream) reclaims
  //    the inner sibling `- ` at the inner indicator's column before the §2a′ fold can swallow it.
  { state: 'indent stack (sibling vs fold)', input: '- - a\n  - b\n- c\n', find: '- b', off: 0, want: 'punctuation',
    notWant: 'string', note: 'inner-sequence sibling `-` is punctuation, not folded into a plain scalar' },
  // the counter-proof — SAME indented `- b` line, but here it MUST fold (no sequence at column 2).
  { state: 'indent stack (counter-proof)', input: 'x: hello\n  - b\n', find: '- b', want: 'string',
    note: 'plain-scalar continuation — `- b` folds (no sequence established at column 2)' },
  // a `-`-led continuation indented STRICTLY DEEPER than the inner indicator (`- - a\n   - b` =
  // `[["a - b"]]`) folds its `-` as plain content: §2c pins the inner column portably (`\1\2 \4`) so the
  // `while` reclaims ONLY a same-column sibling, with a deeper line folded by the body's #block-fold rule.
  { state: 'indent stack (deeper-irregular fold)', input: '- - a\n   - b\n', find: '- b', want: 'string',
    notWant: 'punctuation', note: 'deeper-than-inner `- b` should fold into the plain scalar' },

  // ── indent STACK (NON-FIRST-ITEM compact nest, the monogram#24 generalization): a compact nested
  //    sequence opened by a SECOND-or-later sibling of the outer sequence (`  - - b`, `  - k:`, `  - ? k`),
  //    on a CONTINUATION line. FIXED by the §2c `while` arm 0 (a compact sibling is reclaimed ZERO-WIDTH so
  //    the body re-dispatches it from line start) + #block-value (a `key:`-EOL / `? k`+`:` value block
  //    dispatches its deeper sequence instead of folding it). Reverting either re-paints the deepest `-` string.
  { state: 'indent stack (non-first-item compact nest)', input: '- - a\n  - - b\n    - c\n', find: '- c', want: 'punctuation',
    notWant: 'string', note: 'deepest sibling `- c` of a sibling-opened compact nest is punctuation, not folded' },
  { state: 'indent stack (non-first-item compact nest)', input: '- - a\n  - - b\n    - c\n    - d\n', find: '- d', want: 'punctuation',
    notWant: 'string', note: 'a SECOND deep sibling `- d` is punctuation (the region reclaims every sibling, not just the first)' },
  { state: 'indent stack (non-first-item compact nest)', input: '- - x\n  - - y\n    - z\n  - w\n', find: '- z', want: 'punctuation',
    notWant: 'string', note: 'inner deep sibling `- z` is punctuation even when an OUTER sibling `- w` resumes after it' },
  { state: 'indent stack (non-first-item compact nest)', input: '- - x\n  - - y\n    - z\n  - w\n', find: '- w', want: 'punctuation',
    notWant: 'string', note: 'the outer sibling `- w` resuming after the inner nest is still punctuation' },
  { state: 'indent stack (non-first-item map-value nest)', input: '- - a\n  - k:\n    - x\n    - y\n', find: '- x', want: 'punctuation',
    notWant: 'string', note: 'a sibling item `- k:` whose value is a sequence → `- x` is a sequence indicator, not folded' },
  { state: 'indent stack (non-first-item map-value nest)', input: '- - a\n  - k:\n    - x\n    - y\n', find: '- y', want: 'punctuation',
    notWant: 'string', note: 'every item of the mapping-value sequence stays punctuation' },
  { state: 'indent stack (non-first-item explicit-key nest)', input: '- - a\n  - ? k\n    :\n      - x\n      - y\n', find: '- x', want: 'punctuation',
    notWant: 'string', note: 'a sibling explicit-key item whose value is a sequence → `- x` is a sequence indicator, not folded' },
  // counter-proof: #block-value must NOT fold-dispatch a plain-scalar value continuation (`{k: "v cont"}`)
  { state: 'indent stack (value-block plain continuation)', input: '- - a\n  - k:\n    v\n    cont\n', find: 'cont', want: 'string',
    notWant: 'punctuation', note: 'a plain-scalar value continuation `cont` folds into `v`, not dispatched' },

  // ── indent STACK (explicit-key VALUE position): `? k:\n  - x` is `{ {k:[x]}: null }`, so the `- ` at
  //    column 2 is a sequence indicator and `? ` a map-key indicator — closed by the value-position
  //    transform (valuePositions): `? k:`'s trailing `:` opens a VALUE-POSITION, so the explicit-key /
  //    plain folds yield and the indented value block routes to the shared dispatch.
  { state: 'indent stack (explicit-key value)', input: '? k:\n  - x\n', find: '- x', want: 'punctuation',
    notWant: 'entity.name.tag', note: 'explicit-key value `- x` is a sequence indicator, not a folded key' },
  { state: 'indent stack (explicit-key value)', input: '? k:\n  ? x\n', find: '? x', want: 'punctuation',
    notWant: 'entity.name.tag', note: 'explicit-key value `? x` is a map-key indicator, not a folded key' },
  // counter-proof for the value-position guard: a BARE explicit key still folds as the KEY, and an
  // explicit key with an INLINE value folds its continuation as the VALUE.
  { state: 'indent stack (explicit-key bare-fold)', input: '? a\n  b\n', find: 'b', want: 'entity.name.tag',
    note: 'a bare explicit key `? a\\n  b` folds into the KEY "a b"' },
  { state: 'indent stack (explicit-key inline-value)', input: '? k: hello\n    more\n', find: 'more', want: 'string',
    notWant: 'entity.name.tag', note: 'an explicit key inline value folds the continuation as the VALUE, not the key' },
];
section('witnesses', (fail) => {
  for (const c of cases) {
    let pos = -1;
    for (let k = 0; k <= (c.nth ?? 0); k++) { pos = c.input.indexOf(c.find, pos + 1); if (pos < 0) throw new Error(`witness focus not found: ${JSON.stringify(c.find)}`); }
    pos += c.off ?? 0;
    const got = innerAt(tokenize(tm, c.input), pos);
    const ok = (c.want ? got.startsWith(c.want) : true) && (c.notWant ? !got.startsWith(c.notWant) : true);
    const expectStr = [c.want && `want ${c.want}*`, c.notWant && `not ${c.notWant}*`].filter(Boolean).join(', ');
    if (!ok) fail(`[${c.state}] ${JSON.stringify(c.input)} @«${c.find}» → «${got}» — expected ${expectStr}: ${c.note}`);
  }
  return cases.length;
});

// ── 2. depth-sites: declared indicators × IR-DERIVED value positions ───────────────────────────
// A gap is an (indicator × enclosing VALUE-POSITION) combination the emission missed (`? a:\n  -` is a
// `-` at the explicit-key value position). The positions come from the SAME `valuePositions(grammar)` the
// emitter uses, so emission and verification share one source. Each position is realised as a minimal
// prefix opening its indented value block, a declared indicator (`indent.compactIndicators`) dropped in,
// and the indicator must scope PUNCTUATION (its by-construction role).
const indicators: string[] = grammar.indent?.compactIndicators ?? [];
const vps = valuePositions(grammar) ?? [];
const kvSep = grammar.indent?.keyValueSeparator ?? ':';
section('depth-sites', (fail) => {
  const KEY = 'k';
  const positions: { name: string; prefix: string }[] = [{ name: 'document root', prefix: '' }];
  for (const v of vps) {
    if (v.source === 'keyValueSeparator') positions.push({ name: `map value (${v.introducer})`, prefix: `${KEY}${v.introducer}\n  ` });
    else {
      positions.push({ name: `compact ${v.introducer} (inline)`, prefix: `${v.introducer} ` });
      positions.push({ name: `compact ${v.introducer} (indented)`, prefix: `${v.introducer}\n  ` });
      positions.push({ name: `${v.introducer}-key value`, prefix: `${v.introducer} ${KEY}${kvSep}\n  ` });
    }
  }
  let cells = 0;
  for (const ind of indicators) for (const pos of positions) {
    const input = pos.prefix + `${ind} x`;
    const focus = pos.prefix.length;
    if (!valid(input)) continue;
    cells++;
    const m = innerAt(tokenize(tm, input), focus);
    if (!m.startsWith('punctuation')) fail(`${ind} × ${pos.name}: ${JSON.stringify(input)} @${focus} M→${m}${oracle(input, focus)} (want punctuation)`);
  }
  return cells;
});

// ── 3. flow-sites: a flow opener MID plain scalar is content ───────────────────────────────────
// In BLOCK context `[`/`{` (indent.flowOpen) opens a flow collection only at a node's START; inside a
// begun plain scalar it is content (`a[ b` is the one scalar "a[ b"). A grammar firing `#flow-*` on any
// `[`/`{` mis-scopes it and can swallow the rest of the node.
section('flow-sites', (fail) => {
  const isContent = (scope: string): boolean => scope.startsWith('string') || scope.startsWith('entity');
  const contexts: { name: string; prefix: string }[] = [
    { name: 'document root', prefix: '' },
    { name: 'block-mapping value', prefix: `k${kvSep} ` },
    ...indicators.map(c => ({ name: `compact ${c}`, prefix: `${c} ` })),
  ];
  let cells = 0;
  for (const o of grammar.indent?.flowOpen ?? []) for (const ctx of contexts) {
    const input = `${ctx.prefix}a${o} b`;
    const focus = ctx.prefix.length + 1;
    if (!valid(input)) continue;
    cells++;
    const m = innerAt(tokenize(tm, input), focus);
    if (!isContent(m)) fail(`${o} × ${ctx.name}: ${JSON.stringify(input)} @${focus} M→${m}${oracle(input, focus)} (want content)`);
  }
  return cells;
});

// ── 4. compact-nest: the NON-FIRST-ITEM compact block-sequence nest ────────────────────────────
// A compact sequence opened by a second-or-later sibling of the outer sequence (`  - - b`, `  - k:`,
// `  - ? k`) arrives on a continuation line; the §2c region's consuming sibling-reclaim once ate the
// line's indent before the body ran, so the nested region reconstructed its sibling column too shallow
// and the deeper `-` fell to the plain-scalar fold (`string`). Composed at outer item positions 1..3,
// for each inner kind the value positions allow; EVERY structural sequence indicator must be punctuation.
section('compact-nest', (fail) => {
  const D = indicators[0] ?? '-';   // the block-sequence indicator
  const hasKvValue = vps.some(v => v.source === 'keyValueSeparator');
  const hasExplicit = vps.some(v => v.introducer === '?');
  const innerKinds: { name: string; head: string; deeper: (vi: string) => string[]; gate: boolean }[] = [
    { name: 'compact-seq', head: `${D} ${D} v`, deeper: (vi) => [`${vi}${D} s1`, `${vi}${D} s2`], gate: true },
    { name: 'map-value-seq', head: `${D} k${kvSep}`, deeper: (vi) => [`${vi}${D} s1`, `${vi}${D} s2`], gate: hasKvValue },
    // `? k` sits at the value-block column `vi`, its `:` half aligns at `vi`, its value sequence one level deeper
    { name: 'explicit-key-seq', head: `${D} ? k`, deeper: (vi) => [`${vi}${kvSep}`, `${vi}  ${D} s1`, `${vi}  ${D} s2`], gate: hasExplicit },
  ];
  let cells = 0;
  for (const inner of innerKinds) {
    if (!inner.gate) continue;
    for (let pos = 1; pos <= 3; pos++) {
      // outer `<D> <D> a` (compact), plain siblings `  <D> p<i>` before the target, the target head at
      // the item column (2), its value lines at column 4
      const lines = [`${D} ${D} a`];
      for (let i = 1; i < pos; i++) lines.push(`  ${D} p${i}`);
      lines.push(`  ${inner.head}`, ...inner.deeper('    '));
      const input = lines.join('\n') + '\n';
      if (!valid(input)) continue;
      // witnesses: every `D` followed by a blank / EOL and preceded only by blanks or by `D ` (a compact inline dash)
      const witnesses: number[] = [];
      let off = 0;
      for (const line of lines) {
        for (let i = 0; i < line.length; i++) {
          if (line[i] !== D || (line[i + 1] !== ' ' && line[i + 1] !== undefined)) continue;
          const before = line.slice(0, i);
          if (/^[\t ]*$/.test(before) || /(?:^|[\t ])-[\t ]+$/.test(before)) witnesses.push(off + i);
        }
        off += line.length + 1;
      }
      const toks = tokenize(tm, input);
      for (const w of witnesses) {
        cells++;
        const m = innerAt(toks, w);
        if (!m.startsWith('punctuation')) fail(`${inner.name} @pos${pos} off ${w} «${D}» M→${m}${oracle(input, w)} in ${JSON.stringify(input)}`);
      }
    }
  }
  return cells;
});

// ── 5. deepest-sibling: inline `- - … - a` header + a sibling `- b` at every column ────────────
// The dash at column C is punctuation IFF the `yaml` CST emits a `seq-item-ind` there, both directions:
// UNDER-reclaim (a real sibling folded to string) and OVER-reclaim (a deeper FOLD line claimed as a
// sibling — the regression a too-greedy reclaim causes). d = 1..12 dashes, inter-dash widths all-1,
// all-2 and the alternations [1,2] / [2,1] (each carrier frame consumes its own captured run).
section('deepest-sibling', (fail) => {
  const isSeqDash = (src: string, off: number): boolean => {
    let seq = false;
    const walk = (t: any) => {
      if (!t || typeof t !== 'object') return;
      if (t.type === 'seq-item-ind' && t.offset === off) seq = true;
      for (const k in t) if (t[k] && typeof t[k] === 'object') walk(t[k]);
    };
    for (const tok of new YAML.Parser().parse(src)) walk(tok);
    return seq;
  };
  let checked = 0;
  for (const [name, pat] of [['sp1', [1]], ['sp2', [2]], ['alt12', [1, 2]], ['alt21', [2, 1]]] as const) {
    for (let d = 1; d <= 12; d++) {
      let header = '';
      for (let i = 0; i < d; i++) header += '-' + ' '.repeat(pat[i % pat.length]);
      header += 'a';
      for (let col = 0; col <= header.length + 2; col++) {
        const src = `${header}\n${' '.repeat(col)}- b\n`;
        if (YAML.parseDocument(src).errors.length) continue;   // only VALID YAML
        checked++;
        const off = offsetOf(src, 1, col);
        const isPunct = /punctuation/.test(innerAt(tokenize(tm, src), off));
        const isSeq = isSeqDash(src, off);
        if (isSeq && !isPunct) fail(`UNDER-reclaim (a real sibling folded to string) ${name} d${d} c${col} ${JSON.stringify(src)}`);
        if (!isSeq && isPunct) fail(`OVER-reclaim (a deeper fold claimed as a sibling) ${name} d${d} c${col} ${JSON.stringify(src)}`);
      }
    }
  }
  return checked;
});

// ── 6. blockscalar: the block-scalar content floor at compact depth ─────────────────────────────
// A `|N` / `|` block scalar whose mapping sits in a compact block sequence (`- - … k: |N`) has a content
// floor: a line AT the floor is block content, a line one column shallower ends the scalar (a comment).
// The §2a⁗ carry must place it at ARBITRARY compact depth (monogram#12 #14: a flat floor saturated at
// depth ≥ 2). Both directions against the `yaml` CST: UNDER-floor paints the floor line a comment,
// OVER-floor paints the floor-1 line block string.
section('blockscalar', (fail) => {
  const kindAt = (src: string, off: number): 'blockscalar' | 'comment' | '?' => {
    let kind: 'blockscalar' | 'comment' | '?' = '?';
    const walk = (t: any) => {
      if (!t || typeof t !== 'object') return;
      if (t.offset != null && typeof t.source === 'string' && off >= t.offset && off < t.offset + t.source.length) {
        if (t.type === 'comment') kind = 'comment';
        else if (t.type === 'block-scalar') kind = 'blockscalar';
      }
      for (const k in t) if (t[k] && typeof t[k] === 'object') walk(t[k]);
    };
    for (const tok of new YAML.Parser().parse(src)) walk(tok);
    return kind;
  };
  let checked = 0;
  const check = (label: string, src: string, floor: number) => {
    const lines = src.split('\n');
    const floorLine = lines.findIndex((l) => l.startsWith(' '.repeat(floor) + '#atfloor'));
    const belowLine = lines.findIndex((l) => l.startsWith(' '.repeat(floor - 1) + '#below'));
    if (floorLine < 0 || belowLine < 0) { fail(`${label}: witness malformed`); return; }
    checked += 2;
    const toks = tokenize(tm, src);
    const fOff = offsetOf(src, floorLine, floor), bOff = offsetOf(src, belowLine, floor - 1);
    const gF = innerAt(toks, fOff), oF = kindAt(src, fOff);
    const gB = innerAt(toks, bOff), oB = kindAt(src, bOff);
    if (!(oF === 'blockscalar' && /string\.unquoted\.block/.test(gF))) fail(`${label} FLOOR@${floor}: grammar «${gF}» oracle «${oF}» (want block content)`);
    if (!(oB === 'comment' && /comment/.test(gB))) fail(`${label} FLOOR-1@${floor - 1}: grammar «${gB}» oracle «${oB}» (want comment)`);
  };
  for (let d = 1; d <= 12; d++) {
    const dash = '- '.repeat(d);
    for (const N of [2, 3]) {   // explicit |N: floor = prefix + N
      const floor = dash.length + N;
      const src = `${dash}k: |${N}\n` + ' '.repeat(floor) + '#atfloor\n' + ' '.repeat(floor - 1) + '#below\n';
      if (YAML.parseDocument(src).errors.length === 0) check(`d${d} |${N}`, src, floor);
    }
    const floor = dash.length + 2;   // auto-detect |: the first body line's indent
    const src = `${dash}k: |\n` + ' '.repeat(floor) + '#atfloor\n' + ' '.repeat(floor - 1) + '#below\n';
    if (YAML.parseDocument(src).errors.length === 0) check(`d${d} |auto`, src, floor);
  }
  return checked;
});

let wrong = 0;
for (const r of results) { wrong += r.wrong.length; console.log(`${r.section}: ${r.checked} checked · ${r.wrong.length} wrong`); }
console.log(`\n${results.reduce((n, r) => n + r.checked, 0)} YAML site checks · ${wrong} wrong (${grammarPath})${official ? '' : '  (official RedCMD grammar absent)'}`);
if (wrong) { console.error('\n✗ YAML SITE REGRESSION — a flat-highlighter depth / position site broke'); process.exit(1); }
console.log('✓ every YAML depth / position site scopes as the parser decides');
