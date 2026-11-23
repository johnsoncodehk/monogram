// The shared harness of the portable-targets gates: the TARGET-AGNOSTIC emitter (issue #6) —
// `emitParser(grammar, target)` derives a parser in EACH target language that accepts/rejects the
// same inputs the interpreter (createParser) does. The agnosticism proof by EXECUTION: every
// grammar of test/portable-cases.ts is rendered to TypeScript, Go, and Rust; the Go/Rust sources
// are COMPILED and RUN, and each parser's outcome is compared against the createParser oracle.
//
// The gates check ACCEPT/REJECT PARITY, not byte-identical CST: the portable targets are free to
// use a different internal node shape (arena, compressed CST) as long as they agree with the
// oracle on what parses and what fails; a rule-skeleton snapshot of each accepted input guards
// against semantic drift.
//
// The checks are split into classes, one gate (one process) each, run in parallel by
// test/check.ts; this module is what they share:
//   - test/portable-lists.ts     the hand-written accept/reject lists (and the jsTarget parser on
//                                them), tok-spans, the Unicode corpus, the default-prefix property
//                                of the recovery emission, the empty-entry refusal;
//   - test/portable-edits.ts     edited ≡ fresh: exhaustive one-character edits and the edit
//                                sessions (token alignment, reuse, fast ≡ validated);
//   - test/portable-corpus.ts    the PARITY CORPUS (test/parity-corpus.ts): verdict, rule
//                                skeleton, token stream, literal ids, the Doc path;
//   - test/portable-recovery.ts  total parsing (parseTotal) on the corpus and a mutation corpus.
// A class may run a subset of the grammars (`--grammars=a,b`, or PORTABLE_GRAMMARS=a,b), which is
// how check.ts shards the long ones.
//
// BUILD ONCE, RUN MANY: the compiled Go and Rust runners live in a build cache shared by every
// class and every run (`buildCache` below): an entry is keyed by the sha-256 of everything the
// build reads (the emitted sources, the build command, the toolchain's version), so a hit is
// the same binary a fresh build would give. Two processes that need the same entry build it once:
// one takes the entry's lock, the other builds something else meanwhile and then waits.
//
// Go/Rust toolchains are optional: a missing `go`/`rustc` is logged and skipped (the TS
// rendering, which needs only node, always runs).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { asGoMain } from './go-main.ts';
import { parityInputs, type Tok } from './parity-corpus.ts';
import { goBuild, scratchDir } from './scratch.ts';
import type { CstGrammar } from '../src/types.ts';
import { CASES, type Case } from './portable-cases.ts';

export { CASES, type Case };

/** The failure count of the running class: every check adds to it; `finish` exits on it. */
export const gate = { failures: 0 };

// The element-region grammars' cases may be run alone: --grammars=a,b or PORTABLE_GRAMMARS=a,b;
// check.ts shards a class this way; without it a class runs every case).
export const ONLY = (process.argv.find((a) => a.startsWith('--grammars='))?.slice('--grammars='.length) ?? process.env.PORTABLE_GRAMMARS)?.split(',');
// Likewise PORTABLE_TARGETS=go,rust: which compiled targets run (TypeScript always does).
export const TARGETS_ONLY = process.env.PORTABLE_TARGETS?.split(',');

// tsc's JSX conformance cases (each `// @filename` part one input), when the pinned corpus is present.
export const JSX_GRAMMARS = new Set(['typescriptreact', 'javascriptreact']);
export const JSX_CORPUS = '/tmp/ts-repo/tests/cases/conformance/jsx';
export function jsxCorpus(): string[] {
  if (!existsSync(JSX_CORPUS)) { console.log(`  (no ${JSX_CORPUS}: the JSX conformance parity inputs are skipped)`); return []; }
  return readdirSync(JSX_CORPUS, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name).sort().flatMap((f) => readFileSync(`${JSX_CORPUS}/${f}`, 'utf8').split(/^\/\/\s*@filename:.*$/im));
}
export const sortKeys = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(sortKeys)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]))
  : o;
export const canon = (o: unknown) => JSON.stringify(sortKeys(o));

// Rule-node skeleton: the tree of rule labels with all leaves (trivia/punct/semantic tokens)
// stripped. Two CSTs that differ only in their leaves — e.g. after Phase 5's trivia compression
// — share a skeleton; a semantic restructure (a node relabeled, merged, or dropped) does not.
// A node is a RULE node iff it carries a non-empty `rule` label (Rust leaves use rule:""; TS
// leaves omit the key entirely), so this is target-agnostic over the canon'd JSON.
export const skelObj = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(skelObj).filter((x) => x !== null);
  if (o && typeof o === 'object') {
    const r = (o as { rule?: string }).rule;
    if (r && r !== '') return { r, k: skelObj((o as { children?: unknown }).children ?? []) };
  }
  return null;
};
export const skeleton = (cstStr: string) => skelObj(JSON.parse(cstStr));

export const TMP = scratchDir('portable-targets');
export const have = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
export const HAS_GO = have('go', ['version']);
export const HAS_RUST = have('rustc', ['--version']);
if (!HAS_GO) console.log('  go: (toolchain absent — skipped)');
if (!HAS_RUST) console.log('  rust: (toolchain absent — skipped)');

export type Outcome = { ok: true; cst: string } | { ok: false; err?: string };
export function runProc(cmd: string, args: string[], src: string): Outcome {
  const r = spawnSync(cmd, args, { input: src, encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.status !== 0) return { ok: false, err: r.stderr ?? '' };
  try { return { ok: true, cst: canon(JSON.parse(r.stdout)) }; }
  catch { return { ok: false, err: 'bad json' }; }
}
export function runTokSpans(cmd: string, args: string[], src: string): string | null {
  const r = spawnSync(cmd, args, { input: src, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout;
}
// A native runner's `batch` mode: NUL-separated inputs in, one line per input out — the CST
// JSON, "-" for a rejected input, "!" and the message for a lexer error. An input holding a NUL
// cannot travel that way and runs alone.
export function runBatch(cmd: string, srcs: string[]): Outcome[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch'], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} batch: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src): Outcome => {
    if (src.includes('\0')) return runProc(cmd, [], src);
    const line = lines[li++];
    if (line === '-') return { ok: false };
    if (line.startsWith('!')) return { ok: false, err: line.slice(1) };
    return { ok: true, cst: canon(JSON.parse(line)) };
  });
}
export type Align = { oldN: number; newN: number; prefix: number; suffix: number; relexed?: number; reused?: number; streamEq?: boolean; treeEq?: boolean };
export type EditOutcome = Outcome & { align?: Align };
export function parseAlignStderr(stderr: string): Align | undefined {
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t) as Align; } catch { /* keep scanning */ }
  }
  return undefined;
}
export function runEditSession(cmd: string, args: string[], json: string): EditOutcome {
  const r = spawnSync(cmd, args, { input: json, encoding: 'utf8', maxBuffer: 32 << 20 });
  const align = parseAlignStderr(r.stderr ?? '');
  if (r.status !== 0) return { ok: false, align, err: r.stderr ?? '' };
  try {
    return { ok: true, cst: canon(JSON.parse(r.stdout)), align };
  } catch { return { ok: false, align, err: 'bad json' }; }
}

// A native runner's `batch-edit-session` mode: the payloads NUL-separated in, one line per session
// out (its alignment JSON or nothing, a tab, its CST JSON or "-"). A session that panicked ("!")
// runs again alone in the one-session mode, which reports it as it always did; so does every
// session when the batch process itself fails. PORTABLE_EDIT_COMPARE=1 runs every session both
// ways and throws on the first one whose outcome differs (the proof that batching changes nothing).
export function editSessionBatch(cmd: string, jsons: string[], fast: boolean): EditOutcome[] {
  const one = (json: string) => runEditSession(cmd, [fast ? 'edit-session-fast' : 'edit-session'], json);
  const r = spawnSync(cmd, [fast ? 'batch-edit-session-fast' : 'batch-edit-session'], { input: jsons.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== jsons.length + 1) return jsons.map(one);
  const out = jsons.map((json, i): EditOutcome => {
    const line = lines[i]!;
    if (line === '!') return one(json);
    const tab = line.indexOf('\t');
    const align = tab > 0 ? JSON.parse(line.slice(0, tab)) as Align : undefined;
    const cst = line.slice(tab + 1);
    return cst === '-' ? { ok: false, align } : { ok: true, cst: canon(JSON.parse(cst)), align };
  });
  if (process.env.PORTABLE_EDIT_COMPARE === '1') {
    const key = (o: EditOutcome) => JSON.stringify([o.ok, o.ok ? o.cst : null, o.align ?? null]);
    jsons.forEach((json, i) => { if (key(out[i]!) !== key(one(json))) throw new Error(`${cmd} batch-edit-session differs from edit-session on session ${i}: ${json.slice(0, 200)}`); });
    console.log(`  (PORTABLE_EDIT_COMPARE: ${jsons.length} sessions of ${cmd} ≡ in both modes)`);
  }
  return out;
}

// The ts target's library runs in this process: one module load per grammar instead of one
// node start per input. Go/Rust run their emitted CLI runner per input (a native start is ~1 ms).
export type TsDoc = { edit(edits: { start: number; end: number; text: string }[]): unknown; align(): unknown; root(): unknown };
export type TsLib = {
  parse(src: string): unknown; tokenize(src: string): { kind: string; text: string; nl: boolean; lid: number }[];
  createDoc(src: string, opts: { validate?: boolean; builder?: unknown }): TsDoc;
  /** The library's lid_of, exported by the gate (TS_LID_OF) — the id a Doc gives a rebuilt token. */
  __lid_of(text: string): number;
  parseTotal(src: string, builder: unknown): TsTotal;
  parseWith(src: string, builder: unknown): unknown;
  parseInterpreted(src: string, builder: unknown, depth: number): { root: unknown; steps: number };
  cstBuilder: unknown;
};
// The gate's one addition to the imported ts library: its lid_of, which the runners' lid-of mode
// exposes for go / rust.
export const TS_LID_OF = '\nexport const __lid_of = lid_of;\n';
// A builder that keeps nothing but shifts, so a ts Doc given it takes the builder engine.
export const TS_PROBE_BUILDER = { leaf: () => 1, node: () => 1, shift: (h: number) => h };
export const errText = (e: unknown) => String((e as Error)?.message ?? e);
export function tsRun(lib: TsLib, src: string): Outcome {
  try {
    const root = lib.parse(src);
    return root === null ? { ok: false } : { ok: true, cst: canon(root) };
  } catch (e) { return { ok: false, err: errText(e) }; }
}
export function tsEditSession(lib: TsLib, json: string, fast: boolean): EditOutcome {
  let doc: TsDoc, a: unknown;
  try {
    const { init, batches } = JSON.parse(json) as { init: string; batches: EditBatch[] };
    doc = lib.createDoc(init, { validate: !fast });
    for (const batch of batches) doc.edit(batch.map(([start, end, text]) => ({ start, end, text })));
    a = doc.align();
  } catch (e) { return { ok: false, err: errText(e) }; }
  // Through JSON, as the CLI runner reports it: a field left undefined is absent.
  const align = a ? JSON.parse(JSON.stringify(a)) as Align : undefined;
  try {
    const root = doc.root();
    return root === null ? { ok: false, align } : { ok: true, cst: canon(root), align };
  } catch (e) { return { ok: false, align, err: errText(e) }; }
}

// A token stream as JSON rows [kind, text, newline-before, lid], or null for a lexer error.
export type TokStream = string | null;
/** The rows without their lid: what the oracle lexer (which has no literal ids) also gives. */
export const unLid = (t: TokStream): TokStream => (t === null || t === 'NUL' ? t : JSON.stringify((JSON.parse(t) as unknown[][]).map((r) => r.slice(0, 3))));
export function tokBatch(cmd: string, srcs: string[]): TokStream[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch-tokens'], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} batch-tokens: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src): TokStream => {
    if (src.includes('\0')) return 'NUL';
    const line = lines[li++];
    return line.startsWith('!') ? null : JSON.stringify(JSON.parse(line));
  });
}
export const tsTokens = (lib: TsLib, src: string): TokStream => {
  try { return JSON.stringify(lib.tokenize(src).map((t) => [t.kind, t.text, t.nl, t.lid])); } catch { return null; }
};
// The Doc path: each input typed into an empty Doc in one edit, so the whole text is parsed from
// tokens the Doc rebuilds from its metadata. One outcome per input (a rejection carries no message).
export function docBatch(cmd: string, mode: string, srcs: string[]): (string | null)[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, [mode], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} ${mode}: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src) => (src.includes('\0') ? 'NUL' : lines[li++]!));
}
export const docOutcomes = (lines: (string | null)[]): Outcome[] => lines.map((l) => (l === '-' || l === null ? { ok: false } : l === 'NUL' ? { ok: false, err: 'NUL' } : { ok: true, cst: canon(JSON.parse(l)) }));
export const verdicts = (lines: (string | null)[]): (boolean | null)[] => lines.map((l) => (l === 'NUL' ? null : l === '+'));
export function lidBatch(cmd: string, texts: string[]): number[] {
  const r = spawnSync(cmd, ['lid-of'], { input: texts.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== texts.length + 1) throw new Error(`${cmd} lid-of: exit ${r.status}, ${lines.length - 1} lines for ${texts.length} texts\n${(r.stderr ?? '').slice(0, 2000)}`);
  return lines.slice(0, -1).map(Number);
}
export function tsDoc(lib: TsLib, src: string, builder: boolean): { ok: boolean; cst?: string } {
  try {
    const doc = builder ? lib.createDoc('', { builder: TS_PROBE_BUILDER }) : lib.createDoc('');
    doc.edit([{ start: 0, end: 0, text: src }]);
    const root = doc.root();
    return root === null ? { ok: false } : builder ? { ok: true } : { ok: true, cst: canon(root) };
  } catch { return { ok: false }; }
}

export type Runner = {
  label: string;
  run: (src: string) => Outcome;
  /** `run` over a whole corpus: one outcome per input, in order. */
  batch: (srcs: string[]) => Outcome[];
  /** The lexer alone over a whole corpus. */
  tokens: (srcs: string[]) => TokStream[];
  /** Each input typed into an empty CST Doc ("-" rejected, else its CST JSON). */
  doc: (srcs: string[]) => Outcome[];
  /** The same through the builder Doc, where the target has one apart from the CST Doc: accepted or not. */
  docBuilder?: (srcs: string[]) => (boolean | null)[];
  /** The target's lid_of over texts. */
  lidOf: (texts: string[]) => number[];
  edit: (json: string, fast: boolean) => EditOutcome;
  /** `edit` over many sessions: one outcome per payload, in order (Go / Rust: one process for all). */
  editBatch: (jsons: string[], fast: boolean) => EditOutcome[];
  spans: { cmd: string; args: string[] };
  /** Doc.edit offsets are UTF-8 bytes (go/rust), not UTF-16 units (ts). */
  utf8Edits: boolean;
  /** parseTotal over a whole corpus (the emit option `recovery`): its verdict and diagnostics, offsets in the target's units. */
  total: (srcs: string[]) => Total[];
  /** The strict interpreter (recovery-family.ts) over a whole corpus, `depth` rule levels interpreted. */
  interp: (srcs: string[], depth: number) => Interp[];
};
// One parseTotal outcome: accepted, and each diagnostic as [off, end, message, relOff, relEnd,
// relMessage] (relOff -1: no related location).
export type DiagRow = [number, number, string, number, number, string];
export type Total = { ok: boolean; errors: DiagRow[]; cst?: string };
export function totalBatch(cmd: string, srcs: string[]): Total[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch-total'], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) throw new Error(`${cmd} batch-total: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  let li = 0;
  return srcs.map((src): Total => {
    if (src.includes('\0')) return { ok: false, errors: [[0, 0, 'NUL', -1, -1, '']] };
    const [ok, errors] = JSON.parse(lines[li++]!) as [boolean, DiagRow[]];
    return { ok, errors };
  });
}
// One interpreted parse: its verdict, its tree (the CST JSON, as `batch` gives it), the steps it
// interpreted, and (TS) the leaves the builder was offered by it and by the native parse.
export type Interp = { ok: boolean; cst?: string; steps: number; leaves?: [number, number] };
export function tsInterp(lib: TsLib, src: string, depth: number): Interp {
  let leaves = 0;
  const b = lib.cstBuilder as { leaf: (...a: unknown[]) => unknown; node: (...a: unknown[]) => unknown };
  const counting = { leaf: (...a: unknown[]) => { leaves++; return b.leaf(...a); }, node: (...a: unknown[]) => b.node(...a) };
  try { lib.parseWith(src, counting); } catch { /* a lexer error: no parse, and parseInterpreted rejects it */ }
  const native = leaves;
  leaves = 0;
  try {
    const r = lib.parseInterpreted(src, counting, depth);
    return { ok: r.root !== null, cst: r.root === null ? undefined : canon(r.root), steps: r.steps, leaves: [native, leaves] };
  } catch (e) { return { ok: false, cst: errText(e), steps: -1 }; }
}
export function interpBatch(cmd: string, srcs: string[], depth: number): Interp[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch-interp', String(depth)], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) throw new Error(`${cmd} batch-interp: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  let li = 0;
  return srcs.map((src): Interp => {
    if (src.includes('\0')) return { ok: false, steps: 0 };
    const [ok, steps, cst] = JSON.parse(lines[li++]!) as [boolean, number, string];
    return ok ? { ok, steps, cst: canon(JSON.parse(cst)) } : { ok, steps };
  });
}
export type TsTotal = { root: unknown; errors: { offset: number; end: number; message: string; related?: { offset: number; end: number; message: string } }[] };
export function tsTotal(lib: TsLib, src: string): Total {
  const t = lib.parseTotal(src, lib.cstBuilder);
  return { ok: t.root !== null, cst: t.root === null ? undefined : canon(t.root), errors: t.errors.map((e): DiagRow => [e.offset, e.end, e.message, e.related?.offset ?? -1, e.related?.end ?? -1, e.related?.message ?? '']) };
}
// Every parser of this gate is emitted with total parsing (the emit option `recovery`), whose
// region is appended to the default module and changes none of it: each module begins with the
// default emission, byte for byte.
export const RECOVERY = { recovery: true };

export type EditBatch = [number, number, string][];
export const applyEdits = (init: string, batches: EditBatch[]): string => {
  let text = init;
  for (const batch of batches) for (const [start, end, repl] of batch) text = text.slice(0, start) + repl + text.slice(end);
  return text;
};

// ── Unicode on the real javascript grammar ──
// Every target accepts the oracle's non-ASCII inputs (no panic / no silent reject) with the same
// rule skeleton, rejects what it rejects with the same primary lexer message, and an edit next
// to a multi-byte character (go/rust Doc.edit offsets are UTF-8 bytes) ≡ a fresh parse.
export const UNICODE_ACCEPT: string[] = [
  // template head / middle / tail each carry non-ASCII
  'const head = `héllo`;',
  'const mid = `pré${x}süff`;',
  'const both = `頭${a}中${b}尾🎉`;',
  // comments
  '/* 多行注释 🚀 */\nconst a = 1;',
  '// кириллица коммент\nconst b = 2;',
  // string / regex
  'const s = "日本語🎉";',
  'const r = /[α-ω]+/u;',
  // CJK / emoji ZWJ / combining / 4-byte
  'const z = "👨‍👩‍👧‍👦";',
  'const c = "e\u0301";',
  'const u = "\u{1F600}";',
  'const mix = `café /* not comment */`;',
  'const line = "你好"; // 行尾é',
  // critical closed forms (guard against over-reject after unterminated fix)
  '/* abc */',
  '`cafe`',
  '"abc"',
  "const x = /* abc */ 1;",
  'const x = `cafe`;',
  'const x = "abc";',
  // Unicode whitespace between tokens (JS \s non-ASCII set) — interpreter skips these
  'const a =\u00A01;',              // NBSP
  'const b\u3000= 2;',              // ideographic space
  '\uFEFFconst c = 3;',             // BOM
  'const d\u2003=\u20024;',         // EM space / EN space
  'const e\u202F= 5;',              // narrow NBSP
  'const f\u1680= 6;',              // Ogham space mark
  'const g\u2000=\u200A7;',         // en-quad / hair space (range ends)
  // Unicode identifiers (ID_Start letters) — interpreter's \p{ID_Start} fallback
  'const \u03B1 = \u03B2;',         // α = β
  'const caf\u00E9 = 1;',           // precomposed é
  'const \u5909\u6570 = 42;',       // CJK identifier
  'let \u03C2 = \u03B1 + \u03B2;',  // Greek mix in expression
];

// Non-ASCII at and inside tokens, compared as token streams (kind, text, newline flag, literal id)
// in the parity corpus of the ECMAScript grammars: a lexer that tries at a non-ASCII byte only the
// candidates that can begin with one must still give the interpreter's tokens.
export const NON_ASCII_LEX: string[] = [
  ...UNICODE_ACCEPT,
  'a\u2028b', 'a\u2029b', 'x\u00A0=\u00A0y;', '\uFEFFx\uFEFF;', 'a\u2028\u2029\u3000b', 'return\u2028x;',
  '/* é\u2028 */ x', '/* 日本 */ x\n// é\u2029\ny', '// a\u2028\nb', '/** ドキュメント\u2029 */ y', '/* — ’ … */ z', '// — ’ …\nz',
  'const r = /日本語/u.test(s);', 'x = a / 日 / b;', 'const t = `日本${変数}語 😀`;', "s = '日本\\'語' + \"é\";",
  'const 変数 = 関数(引数, ŉame);', 'let café = naïve + résumé;', 'é', '😀', 'a\u0301b', 'x\u200Cy', '#!é\nx',
  // Identifier characters by Unicode property, across scripts and planes: combining marks (Mn, Mc),
  // ZWJ, connector punctuation (Pc), Other_ID_Start / Other_ID_Continue, letter numbers (Nl),
  // astral ID_Start and ID_Continue, and characters that are letters but not ID_Start
  // (Pattern_Syntax U+2E2F) or symbols (U+2603), which start no identifier.
  'x\u200Dy', 'क्षत्रिय = 1;', 'a\u203Fb + \u2040', '℘ + ℮ + ゛', 'a\u00B7b', 'ⅰⅱ + Ⅻ', 'ab\u0903c',
  '𝑥 = 𝑦 + 1;', 'let 𐐀𐐁 = 1;', 'a\u{E0100}b', '_\u0301', '$\u200C', 'x\u{1F600}', '\u2E2F', 'a\u2E2Fb', 'x = \u2603;',
  'éa1 + a1é', 'α.β?.γ', 'x\u0301\u0301\u0301',
  // Identifier escapes, checked against the same classes: an escape must decode to an
  // IdentifierStart (first) or IdentifierPart character. Accepted: letters, a leading-zero
  // braced escape, a non-ASCII ID_Start, an astral one as a surrogate-pair escape (as the
  // interpreter decodes it), a combining mark after the first character, a private name.
  // Refused: NUL, a private-use and a non-character code point, a digit or combining mark first,
  // lone surrogates, a code point past U+10FFFF, a symbol, a digit-first private name.
  'a\\u0062c', '\\u{000000061}b', '\\u00e9t\\u00E9', '\\uD835\\uDC9C', 'x\\u{1D465}', 'a\\u0301', '#\\u0061 in o', 'class C { #\\u{61}b; }',
  '\\u0000', 'a\\uF000', 'a\\u{10FFFF}', '\\u0030a', '\\u0301a', 'a\\uD800', 'a\\uDC00b', '\\uD835\\u0041', 'a\\u{110000}', 'x\\u2603', 'class C { #\\u0030; }',
];

// Every LineTerminator (LF, CR, LS, PS, and CR LF) ends a line comment, a shebang and a
// triple-slash directive, sets the newline flag of the next token, and ends a regular expression
// (a refusal); compared as token streams in the parity corpus of the ECMAScript grammars.
export const LINE_TERMINATORS: string[] = ['\n', '\r', '\u2028', '\u2029', '\r\n'].flatMap((t) => [
  `// c${t}x;`, `x // c${t}++y`, `a${t}// c${t}b`, `//${t}`, `// é${t}x`, `// \u2028 é \u2029${t}x`,
  `#! sh${t}x;`, `#!${t}x`, `/// <reference path="a" />${t}x;`, `/// <a${t}x`,
  `return // c${t}x;`, `x = y${t}// c${t}/re/g.exec(z)`, `/a${t}b/;`, `/[${t}]/;`, `/a/${t}/b/`,
  `x${t}++y`, `a = \`x${t}y\`;`, `a = \`\${b // c${t}}\`;`, `/* c${t} */ x`,
]);

/** Primary lexer-error text shared with the generated lexer (emit-lexer.ts). */
export function primaryLexMsg(err?: string): string | null {
  if (!err) return null;
  const u = err.match(/Unterminated template literal at offset \d+|Invalid escape sequence in template at offset \d+|Invalid identifier escape at offset \d+: '[^']*'/);
  if (u) return u[0];
  const c = err.match(/Unexpected character at offset \d+: '[\s\S]'/);
  return c ? c[0] : null;
}

// The grammars the refused-operand matrix is written for.
export const ECMASCRIPT = new Set(['javascript', 'typescript']);

// ── The build cache ──
// One directory per entry under `<tmpdir>/monogram-build-cache/`, named by the sha-256 of the
// build's inputs; an entry holds only its outputs and is complete once its `ok` marker exists
// (an entry is built in a private directory and renamed into place, so a reader never sees half
// of one). Lifetime: content-addressed entries are never stale, only unused, so every use touches
// the marker, and the first cache access of a process removes the entries no process has used for
// CACHE_TTL_H hours, then the least recently used ones while the cache is above CACHE_MAX_MB.
// A lock (`<key>.lock`, a directory holding the owner's pid) belongs to a running process; one
// whose owner is gone is taken over.
const CACHE = join(tmpdir(), 'monogram-build-cache');
const CACHE_TTL_H = 24, CACHE_MAX_MB = 3072;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let cacheSwept = false;
function sweepCache(): void {
  cacheSwept = true;
  mkdirSync(CACHE, { recursive: true });
  const now = Date.now();
  const entries: { dir: string; used: number; bytes: number }[] = [];
  for (const n of readdirSync(CACHE)) {
    const dir = join(CACHE, n);
    if (n.endsWith('.lock') || n.includes('.tmp-')) {
      const pid = Number((n.endsWith('.lock') ? safeRead(join(dir, 'pid')) : n.split('.tmp-')[1]) ?? NaN);
      if (Number.isFinite(pid) && !alive(pid)) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    let used: number, bytes = 0;
    try { used = statSync(join(dir, 'ok')).mtimeMs; for (const f of readdirSync(dir)) bytes += statSync(join(dir, f)).size; } catch { rmSync(dir, { recursive: true, force: true }); continue; }
    entries.push({ dir, used, bytes });
  }
  entries.sort((a, b) => a.used - b.used);
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  for (const e of entries) {
    if (now - e.used < CACHE_TTL_H * 3600e3 && total < CACHE_MAX_MB * 1048576) break;
    rmSync(e.dir, { recursive: true, force: true });
    total -= e.bytes;
  }
}
function safeRead(f: string): string | undefined { try { return readFileSync(f, 'utf8'); } catch { return undefined; } }

/** A build: its inputs (hashed into the key) and the function that builds `outputs` into a directory. */
export type Build = { key: string; build: (dir: string) => void };
export const buildKey = (...parts: string[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p.length)).update(':').update(p);
  return h.digest('hex').slice(0, 40);
};
function tryBuild(b: Build): 'done' | 'busy' {
  if (!cacheSwept) sweepCache();
  const dir = join(CACHE, b.key);
  if (existsSync(join(dir, 'ok'))) { const t = new Date(); utimesSync(join(dir, 'ok'), t, t); return 'done'; }
  const lock = `${dir}.lock`;
  try { mkdirSync(lock); } catch {
    const pid = Number(safeRead(join(lock, 'pid')) ?? NaN);
    // a lock without its pid file yet is being taken right now; one whose owner died is free
    if (!Number.isFinite(pid) || alive(pid)) return 'busy';
    rmSync(lock, { recursive: true, force: true });
    return tryBuild(b);
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  try {
    if (!existsSync(join(dir, 'ok'))) {
      const tmp = `${dir}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      b.build(tmp);
      writeFileSync(join(tmp, 'ok'), '');
      renameSync(tmp, dir);
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
  return 'done';
}
/** Builds (or finds) every entry, taking first the ones no other process is building; returns their directories. */
export function buildAll(builds: Build[]): string[] {
  let pending = builds.filter((b) => tryBuild(b) === 'busy');
  while (pending.length) { sleepMs(250); pending = pending.filter((b) => tryBuild(b) === 'busy'); }
  return builds.map((b) => join(CACHE, b.key));
}

const toolVersion = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch { return ''; } };
const GO_VERSION = toolVersion('go', ['version']), RUSTC_VERSION = toolVersion('rustc', ['-vV']);
// The Rust build reads the wrapper or toolchain `rustc` resolves to: its path is part of the key.
const RUSTC_PATH = toolVersion('sh', ['-c', 'command -v rustc']);

// ── One grammar, ready to run: the oracle and a runner per target ──
export type Prepared = {
  c: Case; grammar: CstGrammar; dir: string; runners: Runner[];
  oracleOut: (src: string) => Outcome;
  /** The oracle lexer (compileTokenizer of the grammar's lex spec). */
  tokenize: (s: string) => Tok[];
  /** The emitted sources, without and with the recovery option (the default-prefix property). */
  emitted: { label: string; def: () => string; rec: string }[];
};

// --grammars-except=a,b: every grammar but those (check.ts: the grammars no shard of a class names).
const EXCEPT = process.argv.find((a) => a.startsWith('--grammars-except='))?.slice('--grammars-except='.length).split(',');
export const selectedCases = (): Case[] => CASES.filter((c) => (!ONLY || ONLY.includes(c.grammar)) && !EXCEPT?.includes(c.grammar));

/**
 * Every selected grammar emitted for the three targets (with total parsing, RECOVERY) and its Go
 * and Rust runners built through the cache. `oracleOut` is memoised: the interpreter is a pure
 * function of the text.
 */
export async function prepareAll(cases: Case[] = selectedCases()): Promise<Prepared[]> {
  type Pending = { p: Prepared; tsFile: string; native: { label: 'go' | 'rust'; build: Build }[] };
  const pend: Pending[] = [];
  for (const c of cases) {
    const grammar: CstGrammar = c.parts ? (await import(c.path)).textDialect(c.parts) : (await import(c.path)).default;
    const oracle = createParser(grammar);
    const memo = new Map<string, Outcome>();
    const oracleOut = (src: string): Outcome => {
      let o = memo.get(src);
      if (o === undefined) {
        try { o = { ok: true, cst: canon(oracle.parse(src)) }; } catch (e) { o = { ok: false, err: errText(e) }; }
        memo.set(src, o);
      }
      return o;
    };
    const dir = `${TMP}/${c.grammar}`;
    mkdirSync(dir, { recursive: true });
    // emitParser is the parser LIBRARY (exports a `parse` entry, no I/O); the executable CLI
    // runner (stdin → CST JSON) is the target's emitRunner(), assembled in HERE — the harness's
    // job, not the parser's. ts/rust append the runner to the library (one file); Go needs it as
    // a SEPARATE runner.go in the same `package main` (its import rules forbid appending inline).
    // The ts library is also imported on its own; its CLI runner serves only tok-spans, which reads
    // the parser cursor from inside the module.
    const tsLibSrc = emitParser(grammar, tsTarget, RECOVERY);
    const emitted: Prepared['emitted'] = [{ label: 'typescript', def: () => emitParser(grammar, tsTarget), rec: tsLibSrc }];
    const tsFile = `${dir}/p.ts`;
    writeFileSync(tsFile, tsLibSrc + (tsTarget.emitRunner?.() ?? ''));
    writeFileSync(`${dir}/lib.ts`, tsLibSrc + TS_LID_OF);
    const tsLib = await import(`${dir}/lib.ts`) as TsLib;
    const runners: Runner[] = [{
      label: 'typescript', run: (src) => tsRun(tsLib, src), batch: (srcs) => srcs.map((src) => tsRun(tsLib, src)), tokens: (srcs) => srcs.map((src) => tsTokens(tsLib, src)),
      doc: (srcs) => srcs.map((src) => tsDoc(tsLib, src, false) as Outcome), docBuilder: (srcs) => srcs.map((src) => tsDoc(tsLib, src, true).ok), lidOf: (texts) => texts.map((t) => tsLib.__lid_of(t)),
      edit: (json, fast) => tsEditSession(tsLib, json, fast), editBatch: (jsons, fast) => jsons.map((json) => tsEditSession(tsLib, json, fast)),
      spans: { cmd: 'node', args: [tsFile, 'tok-spans'] }, utf8Edits: false, total: (srcs) => srcs.map((src) => tsTotal(tsLib, src)),
    interp: (srcs, depth) => srcs.map((src) => tsInterp(tsLib, src, depth)),
    }];
    const native: Pending['native'] = [];
    if (HAS_GO && !c.tsOnly && (!TARGETS_ONLY || TARGETS_ONLY.includes('go'))) {
      const goSrc = emitParser(grammar, goTarget, RECOVERY);
      emitted.push({ label: 'go', def: () => emitParser(grammar, goTarget), rec: goSrc });
      const files: Record<string, string> = { 'parser.go': asGoMain(goSrc), 'runner.go': goTarget.emitRunner?.(RECOVERY) ?? '', 'go.mod': 'module p\n\ngo 1.21\n' };
      native.push({ label: 'go', build: {
        key: buildKey('go', GO_VERSION, ...Object.entries(files).flat()),
        build: (out) => {
          const gdir = `${dir}/go`; mkdirSync(gdir, { recursive: true });
          for (const [f, text] of Object.entries(files)) writeFileSync(`${gdir}/${f}`, text);
          goBuild(['-o', `${out}/p`, '.'], { cwd: gdir });
        },
      } });
    }
    if (HAS_RUST && !c.tsOnly && (!TARGETS_ONLY || TARGETS_ONLY.includes('rust'))) {
      const rsSrc = emitParser(grammar, rustTarget, RECOVERY);
      emitted.push({ label: 'rust', def: () => emitParser(grammar, rustTarget), rec: rsSrc });
      const main = rsSrc + (rustTarget.emitRunner?.(RECOVERY) ?? '');
      native.push({ label: 'rust', build: {
        key: buildKey('rust', RUSTC_VERSION, RUSTC_PATH, main),
        build: (out) => {
          const rfile = `${dir}/main.rs`;
          writeFileSync(rfile, main);
          execFileSync('rustc', ['-A', 'warnings', rfile, '-o', `${out}/pr`], { stdio: 'pipe' });
        },
      } });
    }
    let tokenizer: ((s: string) => Tok[]) | undefined;
    const tokenize = (s: string) => (tokenizer ??= compileTokenizer(lexSpecOf(grammar)) as (s: string) => Tok[])(s);
    pend.push({ p: { c, grammar, dir, runners, oracleOut, tokenize, emitted }, tsFile, native });
  }
  const dirs = buildAll(pend.flatMap((x) => x.native.map((n) => n.build)));
  let i = 0;
  for (const { p, native } of pend) {
    for (const n of native) {
      const out = dirs[i++]!;
      const bin = n.label === 'go' ? `${out}/p` : `${out}/pr`;
      p.runners.push(n.label === 'go' ? {
        label: 'go', run: (src) => runProc(bin, [], src), batch: (srcs) => runBatch(bin, srcs), tokens: (srcs) => tokBatch(bin, srcs),
        doc: (srcs) => docOutcomes(docBatch(bin, 'batch-doc', srcs)), docBuilder: (srcs) => verdicts(docBatch(bin, 'batch-doc-builder', srcs)), lidOf: (texts) => lidBatch(bin, texts),
        edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json), editBatch: (jsons, fast) => editSessionBatch(bin, jsons, fast),
        spans: { cmd: bin, args: ['tok-spans'] }, utf8Edits: true, total: (srcs) => totalBatch(bin, srcs), interp: (srcs, depth) => interpBatch(bin, srcs, depth),
      } : {
        label: 'rust', run: (src) => runProc(bin, [], src), batch: (srcs) => runBatch(bin, srcs), tokens: (srcs) => tokBatch(bin, srcs),
        doc: (srcs) => docOutcomes(docBatch(bin, 'batch-doc', srcs)), lidOf: (texts) => lidBatch(bin, texts),
        edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json), editBatch: (jsons, fast) => editSessionBatch(bin, jsons, fast),
        spans: { cmd: bin, args: ['tok-spans'] }, utf8Edits: true, total: (srcs) => totalBatch(bin, srcs), interp: (srcs, depth) => interpBatch(bin, srcs, depth),
      });
    }
  }
  return pend.map((x) => x.p);
}

// ── The parity corpus of a grammar: the inputs test/portable-corpus.ts and test/portable-recovery.ts run ──
export type CorpusInput = { src: string; kind: string };
export function parityCorpus(p: Prepared): CorpusInput[] {
  const c = p.c;
  return [...parityInputs(p.grammar, p.tokenize, { refusedOperands: ECMASCRIPT.has(c.grammar) }),
    ...(ECMASCRIPT.has(c.grammar) ? NON_ASCII_LEX.map((src) => ({ src, kind: 'non-ASCII lexing' })) : []),
    ...(ECMASCRIPT.has(c.grammar) ? LINE_TERMINATORS.map((src) => ({ src, kind: 'line terminators' })) : []),
    ...(JSX_GRAMMARS.has(c.grammar) ? jsxCorpus().map((src) => ({ src, kind: 'tsc JSX conformance' })) : [])];
}

/** The class's last line: the check.ts summary. */
export function finish(what: string): void {
  if (gate.failures > 0) {
    console.error(`\n✗ portable targets diverge from the interpreter: ${what} (${gate.failures} case(s))`);
    process.exit(1);
  }
  console.log(`\n✓ portable parsers (ts/go/rust) ≡ interpreter: ${what}`);
}
