// Gate: LOOKAHEAD EXTENT. An incremental Doc keeps an old top-level entry (a statement, an
// envspec line) only when the edit starts at or after the entry's recorded extent `ext`
// (the reuse driver, tryReuse: `ext <= prefix`). So `ext` must be at least one past the furthest
// token the parse of that entry examined: an extent that is too small keeps a stale entry (the
// tree then differs from a fresh parse only on the inputs where that token mattered), and one
// that is too large throws away an entry the edit cannot affect.
//
// The oracle is independent of the parsers' own bookkeeping (maxLook / max_look): a copy of the
// emitted TS library in which every place the parse engine reads the token array, or tests
// whether an index is inside it, also notes that index. An index tested and found past the end
// counts too, since the parse then depended on there being no token there (an entry that saw the
// end of input must not be kept when text is appended). The gate first checks that those places
// are all the engine has (any other read of the token array fails it). Each entry is then parsed
// again on its own from its first token, and the furthest index noted is the entry's true
// extent.
//
// Every target and every parse path must record exactly that extent, per entry:
//   - a fresh parse (TS CST and builder paths, Go engine and builder paths, the Rust Doc: Rust
//     has one parser, generic over the builder);
//   - after edit sessions (one or two batches at token boundaries: a token deleted, doubled,
//     extended, a space inserted before it) — the Doc's entries, prefix kept, middle reparsed
//     and suffix adopted, against the oracle on the final text.
// Corpus: the parity corpus of every grammar the portable targets reuse entries for, plus real
// files for javascript and typescript. Go / Rust are skipped when their toolchain is absent.
//
//   node test/look-extent.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { emitParser } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { asGoMain } from './go-main.ts';
import { parityInputs, type Tok } from './parity-corpus.ts';
import { scratchDir } from './scratch.ts';
import type { CstGrammar } from '../src/types.ts';
import { cachedGoBuild, cachedRustc } from './build-cache.ts';

const TMP = scratchDir('look-extent');
const ROOT = new URL('..', import.meta.url).pathname;
const have = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const HAS_GO = have('go', ['version']);
const HAS_RUST = have('rustc', ['--version']);
if (!HAS_GO) console.log('  go: (toolchain absent — skipped)');
if (!HAS_RUST) console.log('  rust: (toolchain absent — skipped)');

// Grammars whose entry rule the portable targets split into reusable entries (topReusePlan:
// shape A `star(rule | alt(rule…))`, shape B newline-led segments).
// `files`: more inputs than the parity corpus (whose envspec inputs are mostly one line).
const ENV = ['A=1\nB=2\nC=3', 'A=fn(1,\n2)\nB=3\nC=4', 'A=1\n# note\nB=2\n\n\nC=3', 'X\nA=1\nB=fn(a,\nb)\nC=3', Array.from({ length: 12 }, (_, i) => `K${i}=${i}`).join('\n')];
const ENVTPL = ['A=`x${B}y`\nC=2', 'A=fn(`a`,\nb)\nB=`q${r}s`\nC=1', 'A=1\nB=`z`\nC=`a${b}c${d}e`'];
const GRAMMARS: { name: string; path: string; files?: () => string[] }[] = [
  ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'postjs', 'seqjs', 'sljs', 'arrowjs', 'ledjs', 'noinjs', 'longestjs', 'guardjs', 'lookrec']
    .map((name) => ({ name, path: `./fixtures/${name}.ts`, files: name === 'envspec' ? () => ENV : name === 'envtpl' ? () => ENVTPL : undefined })),
  { name: 'javascript', path: '../javascript.ts', files: () => ['javascript', 'typescript'].map((g) => readFileSync(`${ROOT}tree-sitter/${g}/grammar.js`, 'utf8')) },
  { name: 'typescript', path: '../typescript.ts', files: () => readdirSync(`${ROOT}src`).filter((f) => f.endsWith('.ts')).sort().slice(0, 12).map((f) => readFileSync(`${ROOT}src/${f}`, 'utf8')) },
];
const MAX_EDIT_INPUTS = 120;   // accepted corpus inputs (≥ 2 entries) that seed edit sessions, per grammar

type Ent = [number, number, number];   // tokStart, tokEnd, ext
const fmt = (es: Ent[] | null) => (es === null ? '-' : es.map((e) => e.join(',')).join(';'));
type Batch = [number, number, string][];
type Session = { init: string; batches: Batch[] };

// ── The oracle build ──
// The parse engine's token-array accesses, each guarded by an index test. Each test becomes
// _saw(index), which notes the index and returns the test's result.
const GUARDS: { test: string; index: string }[] = [
  { test: 'pos < toks.length', index: 'pos' },             // peek
  { test: 'pos + 1 < toks.length', index: 'pos + 1' },     // secondIn
  { test: 'j < toks.length', index: 'j' },                 // _opLid: the tokens a '>' composes with
  { test: 'save < toks.length', index: 'save' },           // branch / finishNodeW: an empty node's offset
];
const READS = new Set(['toks[pos]', 'toks[pos + 1]', 'toks[j]', 'toks[save]']);
function oracleSource(lib: string, shapeB: boolean): string {
  // The parse engine the oracle runs: from the parser state to the library entry (the engine
  // and its builder protocol, run with the CST builder). A grammar without '>' composites has no
  // `j` guard; peek's guard is always there.
  const a = lib.indexOf('\nlet toks: Tok[] = [];'), b = lib.indexOf('\n// Library entry.');
  if (a < 0 || b < a) throw new Error('oracle: parse engine bounds not found');
  let engine = lib.slice(a, b);
  if (!engine.includes(GUARDS[0]!.test)) throw new Error('oracle: peek\'s guard not found');
  for (const g of GUARDS) engine = engine.split(g.test).join(`_saw(${g.index})`);
  const left = engine.match(/\btoks(\.length|\[[^\]]*\])/g) ?? [];
  const stray = left.filter((x) => !READS.has(x));
  if (stray.length) throw new Error(`oracle: unguarded token-array access in the parse engine: ${[...new Set(stray)].join(', ')}`);
  const reruns = shapeB
    ? `const n = (e === ents[0] && __isHead() ? parseHeadSegW() : parseLoopSegW()) !== null;`
    : `const n = parseTopOneW();`;
  return `${lib.slice(0, a)}
let _seen = 0;
function _saw(i: number): boolean { if (i + 1 > _seen) _seen = i + 1; return i < toks.length; }
${engine}${lib.slice(b)}
// Shape B: entry 0 is the head segment when the source does not start with the loop token.
let __headFirst = false;
function __isHead(): boolean { return __headFirst; }
export function __oracle(src: string): [number, number, number][] | null {
  _src = src;
  const all = lex(src);
  if (parseTokens(all) === null) return null;
  const ents = _entries.map((e) => ({ ...e }));
  ${shapeB ? `__headFirst = ents.length > 0 && !(all.length > 0 && all[0]!.kid === ${'__LOOP_KID__'});` : ''}
  const out: [number, number, number][] = [];
  for (const e of ents) {
    toks = all; pos = e.tokStart; _seen = 0; _n = 0;
    _capped = false; _form = 0; _tail = false; _suppressNext = null; _suppressCur = null;
    ${reruns}
    if (!n || pos !== e.tokEnd) throw new Error('oracle: entry at token ' + e.tokStart + ' did not parse alone to token ' + e.tokEnd);
    out.push([e.tokStart, e.tokEnd, Math.max(e.tokEnd, _seen)]);
  }
  return out;
}
`;
}

// ── What each target records ──
const TS_PROBE = `
const __id = { leaf: () => 1, node: () => 1, shift: (h: number) => h };
const __ents = (es: EntryMeta[]) => es.map((e) => [e.tokStart, e.tokEnd, e.ext] as [number, number, number]);
export function __fresh(src: string) { return parse(src) === null ? null : __ents(_entries); }
export function __freshW(src: string) { return parseWith(src, __id) === null ? null : __ents(_entries); }
export function __edit(s: { init: string; batches: [number, number, string][][] }, w: boolean) {
  const doc = w ? createDoc(s.init, { builder: __id as any }) : createDoc(s.init);
  for (const b of s.batches) doc.edit(b.map(([start, end, text]) => ({ start, end, text })));
  return doc.root() === null ? null : __ents((doc as any).__entries());
}
`;
function tsProbeSource(lib: string): string {
  const hook = '    align(): Align | null { return align; },';
  const n = lib.split(hook).length - 1;
  if (n !== 1) throw new Error(`probe: expected the Doc object (1 hook), found ${n}`);
  return lib.split(hook).join(`${hook}\n    __entries(): EntryMeta[] { return entries; },`) + TS_PROBE;
}
const GO_PROBE = `package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// The builder (parserW) engine, driven by a builder that shifts (so a Doc edit reuses entries)
// and keeps every node (so its entries are the CST's): the CST builder behind another type.
type wrapCst struct{ *CstBuilder }


func ents(es []EntryMeta, ok bool) string {
	if !ok { return "-" }
	parts := make([]string, len(es))
	for i, e := range es { parts[i] = fmt.Sprintf("%d,%d,%d", e.TokStart, e.TokEnd, e.Ext) }
	return strings.Join(parts, ";")
}

// A lexer error panics: that input has no entries.
func guarded(f func() string) (r string) {
	defer func() { if recover() != nil { r = "-" } }()
	return f()
}

func main() {
	data, _ := io.ReadAll(os.Stdin)
	var out strings.Builder
	for _, rec := range strings.Split(string(data), "\\x00") {
		var s struct {
			Init    string           \`json:"init"\`
			Batches [][][3]interface{} \`json:"batches"\`
		}
		if err := json.Unmarshal([]byte(rec), &s); err != nil { panic(err) }
		batches := make([][]Edit, len(s.Batches))
		for i, b := range s.Batches {
			for _, t := range b { batches[i] = append(batches[i], Edit{Start: int(t[0].(float64)), End: int(t[1].(float64)), Text: t[2].(string)}) }
		}
		cst := guarded(func() string {
			d := NewDoc(s.Init)
			for _, b := range batches { d.Edit(b) }
			return ents(d.entries, d.Root() >= 0)
		})
		out.WriteString(cst)
		out.WriteString("\\t")
		// A builder handle may be a leaf (negative), so acceptance is the CST Doc's.
		out.WriteString(guarded(func() string {
			w := newDocWith(s.Init, wrapCst{&CstBuilder{}})
			for _, b := range batches { w.Edit(b) }
			return ents(w.entries, cst != "-")
		}))
		out.WriteString("\\n")
	}
	os.Stdout.WriteString(out.String())
}
`;
const RUST_PROBE = `
fn ents(es: &[EntryMeta], ok: bool) -> String {
    if !ok { return "-".to_string(); }
    es.iter().map(|e| format!("{},{},{}", e.tok_start, e.tok_end, e.ext)).collect::<Vec<_>>().join(";")
}
fn main() {
    use std::io::Read;
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    std::panic::set_hook(Box::new(|_| {}));
    let mut out = String::new();
    for rec in src.split('\\0') {
        let (init, batches) = parse_edit_session(rec).unwrap();
        let edits: Vec<Vec<Edit>> = batches.iter().map(|b| b.iter().map(|&(s, e, ref t)| Edit { start: s, end: e, text: t.clone() }).collect()).collect();
        // A lexer error panics: that input has no entries.
        let guarded = |f: &dyn Fn() -> String| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f())).unwrap_or_else(|_| "-".to_string());
        out.push_str(&guarded(&|| {
            let mut d = Doc::<CstBuilder>::new(init.clone());
            for b in &edits { d.edit(b); }
            ents(&d.entries, d.root.is_some())
        }));
        out.push('\\n');
    }
    print!("{}", out);
}
`;

/** UTF-16 edit batches → the UTF-8 byte offsets go/rust Doc.edit takes. */
function toUtf8(s: Session): Session {
  const u8 = (t: string, i: number) => Buffer.byteLength(t.slice(0, i), 'utf8');
  let text = s.init;
  const batches = s.batches.map((batch) => {
    const b = batch.map(([st, en, r]): [number, number, string] => [u8(text, st), u8(text, en), r]);
    for (const [st, en, r] of [...batch].sort((x, y) => y[0] - x[0])) text = text.slice(0, st) + r + text.slice(en);
    return b;
  });
  return { init: s.init, batches };
}
const finalText = (s: Session) => {
  let text = s.init;
  for (const batch of s.batches) for (const [st, en, r] of [...batch].sort((x, y) => y[0] - x[0])) text = text.slice(0, st) + r + text.slice(en);
  return text;
};

// Edits at token boundaries: the first changed token is the one an entry's extent is compared with.
function editsAt(src: string, toks: Tok[], k: number): Batch[] {
  const t = toks[k]!, s = t.offset, e = s + t.text.length;
  return [
    [[s, e, '']],                      // token deleted
    [[e, e, ' ' + t.text]],            // token doubled
    [[s, s, ' ']],                     // a space before it: same text, new offset
    [[e, e, t.text.slice(-1)]],        // token extended by its last character
  ];
}

// What is compared: the whole entry list on the CST paths; on a builder path only the extents,
// since a builder may collapse a one-child node and so report its child's token span.
type Runner = { label: string; extOnly: boolean; out: (i: number) => string };
const extsOf = (s: string) => (s === '-' ? '-' : s.split(';').map((e) => e.split(',')[2]).join(','));
const same = (r: Runner, want: string, got: string) => (r.extOnly ? extsOf(want) === extsOf(got) : want === got);
let failures = 0, compared = 0, entriesCompared = 0;
const shown = new Map<string, number>();
const report = (r: Runner, label: string, src: string, want: string, got: string) => {
  if (same(r, want, got)) return;
  failures++;
  const n = shown.get(label) ?? 0;
  shown.set(label, n + 1);
  if (n < 3) {
    console.log(`  ✗ ${label}${n === 0 ? '' : ` (${n + 1})`} on ${JSON.stringify(src.length > 160 ? src.slice(0, 160) + '…' : src)}`);
    console.log(`      oracle ${want.slice(0, 300)}`);
    console.log(`      got    ${got.slice(0, 300)}`);
  }
};
const countEnts = (s: string) => (s === '-' || s === '' ? 0 : s.split(';').length);

// Expected failures: a Doc that rejects after an edit where a fresh parse accepts, for a reason
// that is not the extent. Each must still happen (else the entry is stale and the gate fails).
const EXPECTED_FAIL: { grammar: string; reason: string; applies: (text: string) => boolean }[] = [];

// The comparison itself must see an extent one short: a self-check on a recorded list.
{
  const want = '0,2,3;2,5,5', short = '0,2,2;2,5,5';
  for (const extOnly of [false, true]) if (same({ label: '', extOnly, out: () => '' }, want, short)) throw new Error('self-check: an under-estimate compares equal');
}

for (const g of GRAMMARS) {
  const grammar: CstGrammar = (await import(g.path)).default;
  const dir = `${TMP}/${g.name}`;
  mkdirSync(dir, { recursive: true });
  const lib = emitParser(grammar, tsTarget);
  const shapeB = /\nfunction parseLoopSegW\(/.test(lib);
  let oracleSrc = oracleSource(lib, shapeB);
  if (shapeB) {
    const m = lib.match(/function parseLoopSegW\(\)[^]*?!matchTokW\((\d+)\)/);
    if (!m) throw new Error('oracle: shape-B loop token not found');
    oracleSrc = oracleSrc.replace('__LOOP_KID__', m[1]!);
  }
  writeFileSync(`${dir}/oracle.ts`, oracleSrc);
  writeFileSync(`${dir}/probe.ts`, tsProbeSource(lib));
  const oracle = await import(`${dir}/oracle.ts`) as { __oracle(src: string): Ent[] | null };
  const probe = await import(`${dir}/probe.ts`) as {
    __fresh(src: string): Ent[] | null; __freshW(src: string): Ent[] | null;
    __edit(s: Session, w: boolean): Ent[] | null;
  };
  const oracleOf = (src: string): string => { try { return fmt(oracle.__oracle(src)); } catch (e) { if (String(e).includes('oracle:')) throw e; return '-'; } };
  const guard = (f: () => Ent[] | null): string => { try { return fmt(f()); } catch { return '-'; } };

  // Inputs: the parity corpus (and real files), each once.
  const tokenize = compileTokenizer(lexSpecOf(grammar)) as (s: string) => Tok[];
  // (NUL separates the inputs sent to Go / Rust, so an input holding one is left out.)
  const srcs = [...new Set([...[...parityInputs(grammar, tokenize, { refusedOperands: false })].map((i) => i.src), ...(g.files?.() ?? [])])].filter((src) => !src.includes('\0'));
  const sessions: Session[] = srcs.map((src) => ({ init: src, batches: [] }));
  let seeds = 0;
  for (const src of srcs) {
    if (seeds >= MAX_EDIT_INPUTS) break;
    const want = oracleOf(src);
    if (countEnts(want) < 2) continue;
    let toks: Tok[];
    try { toks = tokenize(src).filter((t) => t.text.length > 0); } catch { continue; }
    if (toks.length < 2) continue;
    seeds++;
    // Token boundaries at, just before and just after each entry's recorded end.
    const ks = new Set<number>();
    for (const e of want.split(';').map((x) => x.split(',').map(Number))) for (const k of [e[1]! - 1, e[1]!, e[2]!, e[2]! - 1]) if (k >= 0 && k < toks.length) ks.add(k);
    const picks = [...ks].sort((a, b) => a - b).filter((_, i, a) => a.length <= 6 || i % Math.ceil(a.length / 6) === 0);
    picks.forEach((k, i) => {
      const es = editsAt(src, toks, k);
      sessions.push({ init: src, batches: [es[i % es.length]!] });
    });
    // Two batches: an edit near the end, then one near the start of the edited text.
    const last = toks[toks.length - 1]!, first = toks[0]!;
    sessions.push({ init: src, batches: [[[last.offset, last.offset, ' ']], [[first.offset + first.text.length, first.offset + first.text.length, ' ' + first.text]]] });
  }

  const want = sessions.map((s) => oracleOf(finalText(s)));
  const runners: Runner[] = [];
  const tsFresh = sessions.map((s, i) => (s.batches.length ? null : [guard(() => probe.__fresh(s.init)), guard(() => probe.__freshW(s.init))]));
  const tsEdit = sessions.map((s) => (s.batches.length ? [guard(() => probe.__edit(s, false)), guard(() => probe.__edit(s, true))] : null));
  runners.push({ label: 'ts', extOnly: false, out: (i) => (tsFresh[i] ?? tsEdit[i])![0]! });
  runners.push({ label: 'ts/builder', extOnly: true, out: (i) => (tsFresh[i] ?? tsEdit[i])![1]! });

  // Go reads JSON; the Rust runner's reader decodes no \u escapes, so it gets the text raw.
  const raw = (t: string) => `"${t.replace(/[\\"]/g, (c) => '\\' + c)}"`;
  const goPayload = sessions.map((s) => JSON.stringify(toUtf8(s))).join('\0');
  const rustPayload = sessions.map((s) => { const u = toUtf8(s); return `{"init":${raw(u.init)},"batches":[${u.batches.map((b) => `[${b.map(([a, e, t]) => `[${a},${e},${raw(t)}]`).join(',')}]`).join(',')}]}`; }).join('\0');
  const lines = (bin: string, payload: string): string[] => {
    const r = spawnSync(bin, [], { input: payload, encoding: 'utf8', maxBuffer: 1 << 30 });
    const out = (r.stdout ?? '').split('\n');
    if (r.status !== 0 || out.length !== sessions.length + 1) throw new Error(`${bin}: exit ${r.status}, ${out.length - 1} lines for ${sessions.length}\n${(r.stderr ?? '').slice(0, 2000)}`);
    return out;
  };
  if (HAS_GO) {
    const gdir = `${dir}/go`; mkdirSync(gdir, { recursive: true });
    writeFileSync(`${gdir}/parser.go`, asGoMain(emitParser(grammar, goTarget)));
    writeFileSync(`${gdir}/probe.go`, GO_PROBE);
    writeFileSync(`${gdir}/go.mod`, 'module p\n\ngo 1.21\n');
    cachedGoBuild(['-o', `${gdir}/p`, '.'], { cwd: gdir });
    const out = lines(`${gdir}/p`, goPayload).map((l) => l.split('\t'));
    runners.push({ label: 'go', extOnly: false, out: (i) => out[i]![0]! }, { label: 'go/builder', extOnly: true, out: (i) => out[i]![1]! });
  }
  if (HAS_RUST) {
    const runner = rustTarget.emitRunner?.() ?? '';
    if (!runner.includes('\nfn main() {')) throw new Error('rust runner: no main to replace');
    writeFileSync(`${dir}/main.rs`, emitParser(grammar, rustTarget) + runner.replace('\nfn main() {', '\n#[allow(dead_code)]\nfn runner_main() {') + RUST_PROBE);
    cachedRustc(['-A', 'warnings', `${dir}/main.rs`, '-o', `${dir}/pr`], { stdio: 'pipe' });
    const out = lines(`${dir}/pr`, rustPayload);
    runners.push({ label: 'rust', extOnly: false, out: (i) => out[i]! });
  }

  const before = failures;
  const xfail = EXPECTED_FAIL.filter((x) => x.grammar === g.name);
  let ents = 0, past = 0, known = 0;
  for (let i = 0; i < sessions.length; i++) {
    const w = want[i]!, text = finalText(sessions[i]!);
    ents += countEnts(w);
    for (const e of w === '-' ? [] : w.split(';')) { const [, b, x] = e.split(',').map(Number); if (x! > b!) past++; }
    const how = sessions[i]!.batches.length ? 'edit' : 'fresh';
    for (const r of runners) {
      const got = r.out(i);
      // Rejected (the Go builder Doc reports a rejection as no entries) where the oracle accepts.
      const rejected = got === '-' || (got === '' && w !== '');
      if (rejected && w !== '-' && xfail.some((x) => x.applies(text))) { known++; continue; }
      report(r, `${g.name}/${r.label}/${how}`, `${text}${how === 'edit' ? `» after ${JSON.stringify(sessions[i]!.batches)}` : ''}`, w, got);
    }
  }
  for (const x of xfail) {
    if (known > 0) console.log(`  (expected failure, owed: ${g.name}: ${known} parses rejected — ${x.reason})`);
    else { failures++; console.log(`  ✗ ${g.name}: expected failure no longer happens (${x.reason}) — remove its EXPECTED_FAIL entry`); }
  }
  compared += sessions.length * runners.length;
  entriesCompared += ents * runners.length;
  console.log(`  ${failures === before ? '✓' : '✗'} ${g.name}: ${sessions.length} inputs (${sessions.length - srcs.length} edit sessions), ${ents} entries (${past} look past their last token) × ${runners.map((r) => r.label).join(', ')}${failures === before ? ' — every extent ≡ oracle' : ` — ${failures - before} mismatches`}`);
}

console.log(`\nlook-extent: ${compared} parses compared, ${entriesCompared} entry extents${failures ? `, ${failures} MISMATCH` : ', all ≡ the oracle'}`);
process.exit(failures ? 1 : 0);
