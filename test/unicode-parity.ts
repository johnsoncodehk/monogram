// Gate: emitted ts/go/rust parsers must accept the same Unicode adversarial inputs as the
// createParser oracle (no panic / no silent reject), and agree on rule-node CST skeletons.
// Also pins edit-session ≡ fresh when edits land near multi-byte characters.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';
import g from '../javascript.ts';

const sortKeys = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(sortKeys)
  : (o && typeof o === 'object')
    ? Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]))
    : o;
const canon = (o: unknown) => JSON.stringify(sortKeys(o));
const skelObj = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(skelObj).filter((x) => x !== null);
  if (o && typeof o === 'object') {
    const r = (o as { rule?: string }).rule;
    if (r && r !== '') return { r, k: skelObj((o as { children?: unknown }).children ?? []) };
  }
  return null;
};
const skeleton = (cstStr: string) => skelObj(JSON.parse(cstStr));

/** JS (UTF-16) index → UTF-8 byte offset (go/rust Doc.edit indices). */
const u8 = (s: string, jsIdx: number): number => Buffer.byteLength(s.slice(0, jsIdx), 'utf8');

type Outcome = { ok: true; cst: string } | { ok: false; err?: string };
function runProc(cmd: string, args: string[], src: string): Outcome {
  const r = spawnSync(cmd, args, { input: src, encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.status !== 0) return { ok: false, err: (r.stderr ?? '').slice(0, 240) };
  try { return { ok: true, cst: canon(JSON.parse(r.stdout)) }; }
  catch { return { ok: false, err: 'bad json' }; }
}
function runEdit(cmd: string, args: string[], json: string): Outcome {
  const r = spawnSync(cmd, args, { input: json, encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.status !== 0) return { ok: false, err: (r.stderr ?? '').slice(0, 240) };
  try { return { ok: true, cst: canon(JSON.parse(r.stdout)) }; }
  catch { return { ok: false, err: 'bad json' }; }
}

const ACCEPT: string[] = [
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
];

type EditBatch = [number, number, string][];
type EditSc = { name: string; init: string; batchesJs: EditBatch[] };

// init = 'const x = "café";' — JS indices: " @10, c@11, a@12, f@13, é@14, "@15, ;@16
const EDIT: EditSc[] = [
  {
    name: 'edit-before-multibyte',
    init: 'const x = "café";',
    batchesJs: [[[14, 14, 'X']]], // insert before é
  },
  {
    name: 'edit-replace-multibyte',
    init: 'const x = "café";',
    batchesJs: [[[14, 15, 'e']]], // replace é
  },
  {
    name: 'edit-after-multibyte',
    init: 'const x = "café";',
    batchesJs: [[[15, 15, '!']]], // after é, before closing quote
  },
];

function applyJs(init: string, batches: EditBatch[]): string {
  let t = init;
  for (const batch of batches) for (const [s, e, r] of batch) t = t.slice(0, s) + r + t.slice(e);
  return t;
}
function toUtf8Batches(init: string, batches: EditBatch[]): EditBatch[] {
  let text = init;
  const out: EditBatch[] = [];
  for (const batch of batches) {
    const b: EditBatch = [];
    const sorted = [...batch].sort((a, c) => c[0] - a[0]);
    for (const [s, e, r] of sorted) b.push([u8(text, s), u8(text, e), r]);
    b.reverse();
    out.push(b);
    for (const [s, e, r] of batch) text = text.slice(0, s) + r + text.slice(e);
  }
  return out;
}

const TMP = '/tmp/unicode-parity';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const have = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const HAS_GO = have('go', ['version']);
const HAS_RUST = have('rustc', ['--version']);

const grammar = g as CstGrammar;
const oracle = createParser(grammar);
const oracleOut = (src: string): Outcome => {
  try {
    const cst = oracle.parse(src);
    if (!cst) return { ok: false };
    return { ok: true, cst: canon(cst) };
  } catch { return { ok: false }; }
};

type Runner = { label: string; run: (src: string) => Outcome; editCmd: string; editArgs: string[]; utf8Edits: boolean };
const runners: Runner[] = [];

writeFileSync(`${TMP}/p.ts`, emitParser(grammar, tsTarget) + (tsTarget.emitRunner?.() ?? ''));
runners.push({ label: 'typescript', run: (src) => runProc('node', [`${TMP}/p.ts`], src), editCmd: 'node', editArgs: [`${TMP}/p.ts`, 'edit-session'], utf8Edits: false });

if (HAS_GO) {
  const gdir = `${TMP}/go`; mkdirSync(gdir, { recursive: true });
  writeFileSync(`${gdir}/parser.go`, emitParser(grammar, goTarget));
  writeFileSync(`${gdir}/runner.go`, goTarget.emitRunner?.() ?? '');
  writeFileSync(`${gdir}/go.mod`, 'module p\n\ngo 1.21\n');
  execFileSync('go', ['build', '-o', `${gdir}/p`, '.'], { cwd: gdir, stdio: 'pipe' });
  runners.push({ label: 'go', run: (src) => runProc(`${gdir}/p`, [], src), editCmd: `${gdir}/p`, editArgs: ['edit-session'], utf8Edits: true });
}
if (HAS_RUST) {
  writeFileSync(`${TMP}/main.rs`, emitParser(grammar, rustTarget) + (rustTarget.emitRunner?.() ?? ''));
  execFileSync('rustc', ['-O', '-A', 'warnings', `${TMP}/main.rs`, '-o', `${TMP}/pr`], { stdio: 'pipe' });
  runners.push({ label: 'rust', run: (src) => runProc(`${TMP}/pr`, [], src), editCmd: `${TMP}/pr`, editArgs: ['edit-session'], utf8Edits: true });
}

let failures = 0;
console.log(`unicode-parity: ${ACCEPT.length} accept cases × ${runners.length} targets + ${EDIT.length} edit-sessions`);

for (const r of runners) {
  let acc = 0, snap = 0;
  for (const src of ACCEPT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (!want.ok) {
      failures++;
      console.log(`  oracle REJECT unexpected on ${JSON.stringify(src)}`);
      continue;
    }
    if (!got.ok) {
      failures++;
      console.log(`  ${r.label}: ACCEPT fail (panic/reject) on ${JSON.stringify(src)} err=${got.err ?? ''}`);
      continue;
    }
    acc++;
    if (canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
      snap++;
      failures++;
      console.log(`  ${r.label}: SHAPE drift on ${JSON.stringify(src)}`);
    }
  }
  console.log(`  ${r.label}: ${acc}/${ACCEPT.length} accept ≡ oracle${snap ? ` · ${snap} shape drift` : ''}`);

  let editOk = 0;
  for (const sc of EDIT) {
    const final = applyJs(sc.init, sc.batchesJs);
    const batches = r.utf8Edits ? toUtf8Batches(sc.init, sc.batchesJs) : sc.batchesJs;
    const payload = JSON.stringify({ init: sc.init, batches });
    const a = runEdit(r.editCmd, r.editArgs, payload);
    const b = r.run(final);
    const o = oracleOut(final);
    if (a.ok === b.ok && (!a.ok || a.cst === b.cst) && a.ok === o.ok) editOk++;
    else {
      failures++;
      console.log(`  ${r.label}: edit-session mismatch (${sc.name}) final=${JSON.stringify(final)} A ok=${a.ok} B ok=${b.ok} oracle ok=${o.ok} err=${a.err ?? ''}`);
    }
  }
  console.log(`  ${r.label}: ${editOk}/${EDIT.length} edit-sessions ≡ fresh`);
}

if (failures) {
  console.log(`\n✗ unicode-parity: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\n✓ unicode-parity: ${ACCEPT.length} cases × ${runners.length} targets + ${EDIT.length} edits/target ≡ oracle`);
