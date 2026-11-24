// ─────────────────────────────────────────────────────────────────────────────
//  cpython.ts — the Python grammar (`python.ts`, run by the interpreter) against the reference
//  parser, over CPython's own Lib/ (the standard library and its test suite) at the pin in
//  test/cpython.sha (v3.10.12). Not a gate of test/check.ts: the CI job `python` (.github/workflows/
//  ci.yml) installs the oracle, clones the corpus and runs it; locally run
//  ~/.cache/monogram-agents/restore-cpython.sh <repo> first. The sources are DATA: parsed, never
//  executed, never copied into this repository.
//
//  The oracle is `ast.parse` of Python 3.10.12 (the tokenizer, the PEG parser and the string
//  actions; never `compile()`, whose symbol-table and compiler errors are not syntax), given the
//  file's bytes so its coding cookie decides the decoding. Every disagreement gets a CAUSE CLASS
//  below. The record: test/cpython-record.txt (the counts, then every disagreeing file under its
//  class). The gate regenerates it and fails on ANY difference, and while a disagreement has no
//  class (`accept/unknown`, `reject/unknown`). docs/SECOND-LANGUAGE.md quotes the counts.
//
//  Run (bare node):
//    node test/cpython.ts            # check: fail if the record is stale
//    node test/cpython.ts --write    # (re)write test/cpython-record.txt
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser } from '../src/interpreter/interpreter.ts';
import python from '../python.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join(ROOT, 'test/cpython-record.txt');
const PIN = readFileSync(join(ROOT, 'test/cpython.sha'), 'utf8').trim();
const CORPUS = '/tmp/cpython';
const PYTHON = process.env.MONOGRAM_PYTHON ?? 'python3';
const WANT_PY = '3.10.12';
const WRITE = process.argv.includes('--write');

if (!existsSync(join(CORPUS, 'Lib'))) {
  console.error(`✗ NOT RUN: the pinned CPython corpus is absent at ${CORPUS}/Lib.`);
  console.error('  Provision it as CI does (.github/workflows/ci.yml, "Clone the pinned CPython corpus").');
  process.exit(1);
}
const head = readFileSync(join(CORPUS, '.git/HEAD'), 'utf8').trim();
if (head !== PIN) { console.error(`✗ NOT RUN: ${CORPUS} is at ${head}, the pin (test/cpython.sha) is ${PIN}. Re-clone it.`); process.exit(1); }
let pyVersion = '';
try { pyVersion = execFileSync(PYTHON, ['-I', '-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).trim(); } catch { /* reported below */ }
if (pyVersion !== WANT_PY) { console.error(`✗ NOT RUN: the oracle must be Python ${WANT_PY} (${PYTHON} is ${pyVersion || 'absent'}; set MONOGRAM_PYTHON).`); process.exit(1); }

// ── the corpus ──
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = join(d, e.name);
  return e.isDirectory() ? walk(f) : e.name.endsWith('.py') ? [f] : [];
});
const files = walk(join(CORPUS, 'Lib')).sort();
const paths = files.map((f) => f.slice(CORPUS.length + 1));

// ── the oracle: one python process for every file ──
const ORACLE = String.raw`
import ast, json, sys, warnings
warnings.simplefilter('ignore')
out = []
for f in json.load(sys.stdin):
    try:
        ast.parse(open(f, 'rb').read())
        out.append(None)
    except SyntaxError as e:
        out.append(type(e).__name__ + ': ' + str(e.msg))
    except (ValueError, MemoryError, RecursionError) as e:
        out.append(type(e).__name__ + ': ' + str(e))
json.dump(out, sys.stdout)
`;
const ref: (string | null)[] = JSON.parse(execFileSync(PYTHON, ['-I', '-c', ORACLE], { input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 1 << 28 }));

// ── ours ──
const parser = createParser(python);
const utf8 = new TextDecoder('utf-8', { fatal: true });
interface Row { path: string; src: string | null; ref: string | null; ours: string | null }
const rows: Row[] = files.map((f, i) => {
  let src: string | null = null;
  try { src = utf8.decode(readFileSync(f)); } catch { /* not UTF-8: the oracle decoded it by its cookie */ }
  if (src !== null && src.charCodeAt(0) === 0xfeff) src = src.slice(1);   // a BOM is the encoding's, not the text's
  let ours: string | null = null;
  if (src === null) ours = 'not UTF-8';
  else { try { parser.parse(src); } catch (e) { ours = (e instanceof Error ? e.message : String(e)).split('\n')[0]; } }
  return { path: paths[i], src, ref: ref[i], ours };
});

// ── the classes: the first whose predicate holds is a disagreement's class ──
// Verdicts: `not-syntax` the reference rejects for a reason that is not the grammar's (a string
// action, a decoder, an encoding); `owed-M1` / `owed-M2` / `owed-M3` an engine mechanism of
// docs/SECOND-LANGUAGE.md (approved, not built yet); `grammar-bug` the grammar is wrong.
interface CauseClass { id: string; verdict: string; why: string; match: (r: Row) => boolean }
const lineLeads = (src: string, re: RegExp) => src.split(/\r\n|\r|\n/).some((l) => re.test(l));
const failAt = (r: Row): number => Number(/offset (\d+)/.exec(r.ours ?? '')?.[1] ?? -1);
const CLASSES: CauseClass[] = [
  { id: 'accept/bytes-str-concatenation', verdict: 'not-syntax',
    why: 'adjacent bytes and str literals: python.gram derives `STRING+`; the concatenation action raises "cannot mix bytes and nonbytes literals"',
    match: (r) => r.ours === null && /cannot mix bytes and nonbytes literals/.test(r.ref!) },
  { id: 'accept/escape-decoding', verdict: 'not-syntax',
    why: 'a well-formed escape the decoder refuses (`\\N{name}` of no Unicode character): a table lookup, not syntax',
    match: (r) => r.ours === null && /\(unicode error\)/.test(r.ref!) },
  { id: 'accept/f-string-field', verdict: 'owed-M2',
    why: 'an f-string whose replacement field the reference rejects: f-strings are lexed as plain strings until templates can spell them',
    match: (r) => r.ours === null && /^SyntaxError: f-string/.test(r.ref!) },
  { id: 'accept/encoding-declaration', verdict: 'not-syntax',
    why: 'a coding cookie the decoder refuses (`uft-8`; `utf8` after a BOM): the bytes are decoded before any token, and the harness reads UTF-8',
    match: (r) => r.ours === null && /^SyntaxError: (unknown encoding|encoding problem)/.test(r.ref!) },
  { id: 'reject/not-utf8', verdict: 'not-syntax',
    why: 'a source in another encoding (its coding cookie): the grammar reads text, the harness reads UTF-8',
    match: (r) => r.src === null },
  { id: 'reject/comment-after-code', verdict: 'owed-M1',
    why: 'a comment glued to the code before it (`x=1#c`): indent mode starts a comment only after whitespace, which is YAML\'s rule, for every indent grammar',
    match: (r) => r.ref === null && /Unexpected character at offset \d+: '#'/.test(r.ours!) && !/[ \t\r\n]/.test(r.src!.charAt(failAt(r) - 1)) },
  { id: 'reject/form-feed', verdict: 'owed-M1',
    why: 'a form feed in leading whitespace (Python resets the column): indent mode counts spaces only',
    match: (r) => r.ref === null && lineLeads(r.src!, /^[ \t]*\f/) },
  { id: 'reject/tab-indent', verdict: 'owed-M1',
    why: 'a tab in leading whitespace: indent mode measures spaces only (a tab is YAML\'s error or skipped), Python moves to the next multiple of 8',
    match: (r) => r.ref === null && lineLeads(r.src!, /^ *\t/) },
  { id: 'reject/flow-line-indent', verdict: 'owed-M1',
    why: 'a bracketed line after `:` less indented than its block (`if x: [\\n1]`): YAML\'s §7.4 flow rule applies to every indent grammar',
    match: (r) => r.ref === null && /Flow collection line is not sufficiently indented/.test(r.ours!) },
  { id: 'accept/identifier-dollar', verdict: 'owed-M3',
    why: 'a `$` taken as an identifier character: the Unicode identifier fallback is ECMAScript\'s',
    match: (r) => r.ours === null && r.src!.includes('$') },
];
const UNKNOWN = { accept: 'accept/unknown', reject: 'reject/unknown' };
const classOf = (r: Row): string => CLASSES.find((c) => c.match(r))?.id ?? (r.ours === null ? UNKNOWN.accept : UNKNOWN.reject);

// ── the record ──
const byClass = new Map<string, string[]>();
let agreeAccept = 0, agreeReject = 0, weAccept = 0, weReject = 0;
for (const r of rows) {
  const okRef = r.ref === null, okUs = r.ours === null;
  if (okRef === okUs) { if (okRef) agreeAccept++; else agreeReject++; continue; }
  if (okUs) weAccept++; else weReject++;
  const c = classOf(r);
  if (!byClass.has(c)) byClass.set(c, []);
  byClass.get(c)!.push(r.path);
}
const order = [...CLASSES.map((c) => c.id), UNKNOWN.accept, UNKNOWN.reject].filter((id) => byClass.has(id));
const lines = [
  `# python.ts (interpreter) against ast.parse of Python ${WANT_PY} over python/cpython@${PIN} Lib/. Generated by \`node test/cpython.ts --write\`; do not edit.`,
  `# ${rows.length} files: ${agreeAccept + agreeReject} agree (${agreeAccept} accept, ${agreeReject} reject), WE-ACCEPT ${weAccept}, WE-REJECT ${weReject}.`,
  `# ${order.map((id) => `${id} ${byClass.get(id)!.length}`).join(', ') || 'no disagreement'}`,
  ...order.flatMap((id) => {
    const c = CLASSES.find((k) => k.id === id);
    return [`## ${id}${c ? ` (${c.verdict}): ${c.why}` : ': no class claims these yet'}`, ...byClass.get(id)!];
  }),
];
const text = lines.join('\n') + '\n';
console.log(lines[1].slice(2));
console.log(lines[2].slice(2));
if (WRITE) { writeFileSync(RECORD, text); console.log('✓ wrote test/cpython-record.txt'); process.exit(0); }
const old = existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '';
const unknown = (byClass.get(UNKNOWN.accept)?.length ?? 0) + (byClass.get(UNKNOWN.reject)?.length ?? 0);
if (old !== text) {
  const before = new Set(old.split('\n').filter((l) => l && !l.startsWith('#')));
  const after = new Set(text.split('\n').filter((l) => l && !l.startsWith('#')));
  for (const l of after) if (!before.has(l)) console.log(`  + ${l}`);
  for (const l of before) if (!after.has(l)) console.log(`  - ${l}`);
  console.error('✗ cpython: test/cpython-record.txt is stale (node test/cpython.ts --write)');
  process.exit(1);
}
if (unknown) { console.error(`✗ cpython: ${unknown} disagreements have no class`); process.exit(1); }
console.log('✓ cpython: the record holds');
