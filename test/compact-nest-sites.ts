// compact-nest-sites.ts — an IR-derived enumerator + witness MATRIX for the NON-FIRST-ITEM compact
// block-sequence nest (the monogram#24 generalization).
//
// monogram#24 (the FIRST-item case `- - a\n  - b`) was closed by the gen-tm §2c column-anchored compact
// block-sequence region. But a compact sequence opened by a SECOND-or-later sibling of the outer sequence
// — `  - - b` (a deeper compact seq), `  - k:` (a sibling whose value is a sequence), `  - ? k` (an
// explicit-key value sequence) — arrives on a CONTINUATION line, where the region's consuming sibling-
// reclaim ate the line's indent BEFORE the body ran, so the nested region opened mid-line and reconstructed
// its sibling column too shallow → the deeper sibling `-` fell through to the plain-scalar fold and was
// painted `string` (the parser assigns it `$punct`; official scopes `punctuation.definition.block.sequence.item`).
// The §2c fix is the `while` arm 0 (a compact sibling reclaimed ZERO-WIDTH so the body re-dispatches it from
// line start, opening a column-correct nested #block-sequence) + #block-value (a `key:`-EOL value block
// dispatches its deeper sequence instead of folding it).
//
// THEOREM (the same one behind depth-sites / yaml-depth-witnesses): where a construct's correct scope
// depends on cross-line indent STATE the parser keeps on a stack, and the derived TextMate grammar is flat,
// the set of inputs where they disagree is provably NON-EMPTY. So we don't wait for a corpus — we CONSTRUCT
// the non-first-item compositions: a compact OUTER sequence, then at item position 1, 2, 3, … a compact
// inner block of each kind (seq / mapping-value seq / explicit-key-value seq), and ASSERT every
// sequence-indicator `-` is `punctuation` (its by-construction parser role). A valid-YAML cell that
// mis-scopes a `-` is a guaranteed depth bug. Self-contained: a cell FAILS when Monogram does not scope the
// indicator punctuation — no external corpus needed (so it runs in `npm run check`). The official RedCMD
// grammar, when present (local dev / readme-bench), is shown for context and confirms the fix matches a
// maintained grammar (not a TextMate-frontier limit).
//
// DERIVED, not hand-listed: the sequence indicator + the compact shape come from detectBlockSequence(grammar)
// and indent.{compactIndicators,keyValueSeparator}; the value-block kinds come from valuePositions(grammar).
// So the emitter and this gate share ONE source — a nest shape the §2c region claims is exactly one this
// probe tests.
//
// Run (bare node): node test/compact-nest-sites.ts
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { parse as yamlParse } from 'yaml';
import grammar from '../yaml.ts';
import { valuePositions } from '../src/gen-tm.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
await loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
function load(files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar('source.yaml');
}
const tm = (await load({ 'source.yaml': 'yaml.tmLanguage.json' }))!;
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
function innerAt(toks: Tok[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const s = ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
  return (s.length ? s[s.length - 1] : '(none)').replace(/\.yaml$/, '');
}
const valid = (s: string): boolean => { try { yamlParse(s); return true; } catch { return false; } };

// ── DERIVED structural facts (nothing hardcoded) ──
const indicators: string[] = grammar.indent?.compactIndicators ?? [];   // `-`, `?`
const seqIndicator = indicators[0] ?? '-';   // the block-sequence indicator (detectBlockSequence's literal)
const kvSep = grammar.indent?.keyValueSeparator ?? ':';
const vps = valuePositions(grammar) ?? [];
const hasKvValue = vps.some(v => v.source === 'keyValueSeparator');     // `:` opens a value block
const hasExplicit = vps.some(v => v.introducer === '?');               // `?` explicit-key value block

// An INNER compact block of each kind, written as the lines AFTER the opening `<seq> ` of a sibling item.
// Each returns: the sibling-item HEAD (placed right after the outer `<seq> `), and the deeper value LINES
// (already indented to the value-block column = headIndent + 2), whose leading `<seq>` indicators are the
// witnesses (must be punctuation). `D` = the sequence indicator (e.g. `-`).
const D = seqIndicator;
interface InnerKind { name: string; head: string; deeper: (vIndent: string) => string[]; gate: boolean; }
const innerKinds: InnerKind[] = [
  // a deeper COMPACT sequence: the sibling item is itself `<seq> <seq> v`, its siblings at the inner column
  { name: 'compact-seq', head: `${D} ${D} v`, deeper: (vi) => [`${vi}${D} s1`, `${vi}${D} s2`], gate: true },
  // a MAPPING-VALUE sequence: the sibling item is `<seq> k:` and its value is a sequence one level deeper
  { name: 'map-value-seq', head: `${D} k${kvSep}`, deeper: (vi) => [`${vi}${D} s1`, `${vi}${D} s2`], gate: hasKvValue },
  // an EXPLICIT-KEY value sequence: the sibling item is `<seq> ? k` — the `?` sits at the value-block column
  // `vi` (after `<seq> `), so the `:` half aligns at `vi`, and the explicit-key VALUE sequence is one level
  // DEEPER (`vi` + 2 spaces).
  { name: 'explicit-key-seq', head: `${D} ? k`, deeper: (vi) => [`${vi}${kvSep}`, `${vi}  ${D} s1`, `${vi}  ${D} s2`], gate: hasExplicit },
];

// Build a non-first-item composition: an OUTER compact sequence whose item at POSITION `pos` (1-based,
// ≥1 means non-first since position 0 is the first item) opens `inner`. The outer is `<seq> <seq> a` so it
// is genuinely COMPACT; preceding sibling items (positions 1..pos-1) are plain `<seq> p`. The target item
// sits at the outer item column (2 spaces, after the outer `<seq> `). Its value block is at column 4.
function compose(inner: InnerKind, pos: number): { input: string; witnesses: number[] } {
  const itemIndent = '  ';            // the outer sequence's item column (after `<seq> `)
  const valueIndent = '    ';         // the value-block column (itemIndent + 2)
  const lines: string[] = [`${D} ${D} a`];   // line 0: outer `<seq> <seq> a` (compact, first item = `a`)
  for (let i = 1; i < pos; i++) lines.push(`${itemIndent}${D} p${i}`);   // plain sibling items before the target
  // the target sibling item: its head goes right after the item indent (the leading `<seq> ` of `head`)
  lines.push(`${itemIndent}${inner.head}`);
  for (const dl of inner.deeper(valueIndent)) lines.push(dl);
  const input = lines.join('\n') + '\n';
  // witnesses: the byte offset of every sequence-indicator `D` that is a STRUCTURAL item indicator. We take
  // the leading `D` of each line that begins (after indent) with `D `, EXCEPT a line that is purely the
  // explicit `:` continuation. That covers: line 0's two dashes, each plain sibling's dash, the target head's
  // dash(es), and every deeper value `D s` line's dash.
  const witnesses: number[] = [];
  let off = 0;
  for (const line of lines) {
    // every `D` immediately followed by a space (or EOL) that is preceded only by whitespace OR by `D `
    // (a compact inline second dash) is a structural sequence indicator.
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== D) continue;
      const after = line[i + 1];
      if (after !== ' ' && after !== undefined) continue;
      const before = line.slice(0, i);
      if (/^[\t ]*$/.test(before) || /(?:^|[\t ])-[\t ]+$/.test(before)) witnesses.push(off + i);
    }
    off += line.length + 1;
  }
  return { input, witnesses };
}

console.log(`sequence indicator (detectBlockSequence): ${JSON.stringify(seqIndicator)}`);
console.log(`value-block kinds (IR-derived): ${innerKinds.filter(k => k.gate).map(k => k.name).join(', ')}`);
console.log(`legend: M=Monogram O=official(RedCMD) · every sequence-indicator «${D}» must be PUNCTUATION (its parser role)\n`);

let cells = 0, monoWrong = 0, skipped = 0;
const wrong: string[] = [];
for (const inner of innerKinds) {
  if (!inner.gate) continue;
  for (let pos = 1; pos <= 3; pos++) {     // non-first item positions 1, 2, 3
    const { input, witnesses } = compose(inner, pos);
    if (!valid(input)) { skipped++; console.log(`  – skip  [${inner.name} @pos${pos}] ${JSON.stringify(input)} (invalid YAML)`); continue; }
    const mToks = tokenize(tm, input);
    const oToks = official ? tokenize(official, input) : null;
    let cellWrong = false;
    for (const w of witnesses) {
      cells++;
      const m = innerAt(mToks, w);
      const mOk = m.startsWith('punctuation');
      const o = oToks ? innerAt(oToks, w) : null;
      if (!mOk) { monoWrong++; cellWrong = true; wrong.push(`${inner.name}@pos${pos} off${w} M→${m}`); }
      if (!mOk) console.log(`  ✗ BUG  [${inner.name} @pos${pos}] off ${w} «${D}» M→${m}${o === null ? '' : `  O→${o}`}  in ${JSON.stringify(input)}`);
    }
    if (!cellWrong) console.log(`  ✓ ok   [${inner.name} @pos${pos}]  ${witnesses.length} indicators all punctuation  ${JSON.stringify(input)}`);
  }
}
console.log(`\n  ${cells} indicator cells · ${cells - monoWrong} ok · ${monoWrong} mis-scoped${official ? '' : '  (Monogram-only — official oracle absent)'} · ${skipped} skipped`);
if (monoWrong) { console.error(`\n  COMPACT-NEST REGRESSION — a non-first-item sequence indicator not scoped punctuation: ${wrong.join(' · ')}`); process.exit(1); }
console.log('  ✓ every non-first-item compact-nest sequence indicator scopes punctuation — closed by construction.');
