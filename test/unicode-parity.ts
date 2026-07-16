// Gate: emitted ts/go/rust parsers must accept the same Unicode adversarial inputs as the
// createParser oracle (no panic / no silent reject), and agree on rule-node CST skeletons.
// Also pins edit-session ≡ fresh when edits land near multi-byte characters, and unterminated
// closed-token reject (block comment / template / string) with lexer messages ≡ oracle.
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

/** Primary lexer-error text shared with createLexer (gen-lexer.ts). */
function primaryLexMsg(err?: string): string | null {
  if (!err) return null;
  const u = err.match(/Unterminated template literal at offset \d+/);
  if (u) return u[0];
  const c = err.match(/Unexpected character at offset \d+: '[\s\S]'/);
  return c ? c[0] : null;
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

/** Reject cases. `lexMsg` set ⇒ expect that primary lexer message in stderr (≡ oracle). */
const REJECT: { src: string; lexMsg: string | null }[] = [
  { src: '/* abc', lexMsg: null }, // unterminated block → `/`+`*` puncts → parse reject (not a lex throw)
  { src: '`cafe', lexMsg: 'Unterminated template literal at offset 5' },
  { src: '"abc', lexMsg: 'Unexpected character at offset 0: \'"\'' },
  { src: "'abc", lexMsg: "Unexpected character at offset 0: '''" },
  { src: 'const x = `cafe', lexMsg: 'Unterminated template literal at offset 15' },
  { src: 'const x = "abc', lexMsg: 'Unexpected character at offset 10: \'"\'' },
  // emoji is not ID_Start; ZWSP is not JS \s — all targets must reject (messages differ in
  // encoding of the offending char across targets, so no lexMsg pin)
  { src: 'const \u{1F600} = 1;', lexMsg: null },
  { src: 'const x\u200B= 1;', lexMsg: null },
];

type EditBatch = [number, number, string][];
type EditSc = { name: string; init: string; batchesJs: EditBatch[]; expectFinalOk?: boolean };

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
  // delete closing backtick → reject; restore → accept (edit ≡ fresh)
  {
    name: 'edit-unterm-template-restore',
    // const x = `cafe`;  — closing ` at 15
    init: 'const x = `cafe`;',
    batchesJs: [[[15, 16, '']], [[15, 15, '`']]],
    expectFinalOk: true,
  },
  // delete `*/` → reject; restore → accept
  {
    name: 'edit-unterm-block-restore',
    // /* abc */\nconst a = 1;  — `*/` at 7..9
    init: '/* abc */\nconst a = 1;',
    batchesJs: [[[7, 9, '']], [[7, 7, '*/']]],
    expectFinalOk: true,
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
  } catch (e) { return { ok: false, err: (e as Error).message }; }
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
console.log(`unicode-parity: ${ACCEPT.length} accept + ${REJECT.length} reject × ${runners.length} targets + ${EDIT.length} edit-sessions`);

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

  let rej = 0;
  for (const { src, lexMsg } of REJECT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (want.ok || got.ok) {
      failures++;
      console.log(`  ${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
      continue;
    }
    if (lexMsg !== null) {
      const gotMsg = primaryLexMsg(got.err);
      const wantMsg = primaryLexMsg(want.err) ?? lexMsg;
      if (gotMsg !== wantMsg) {
        failures++;
        console.log(`  ${r.label}: REJECT msg drift on ${JSON.stringify(src)}\n    want ${wantMsg}\n    got  ${gotMsg ?? got.err}`);
        continue;
      }
    }
    rej++;
  }
  console.log(`  ${r.label}: ${rej}/${REJECT.length} reject ≡ oracle`);

  let editOk = 0;
  for (const sc of EDIT) {
    // Intermediate: after the first batch alone, unterminated-restore cases must reject.
    if (sc.name.startsWith('edit-unterm-') && sc.batchesJs.length >= 2) {
      const mid = applyJs(sc.init, sc.batchesJs.slice(0, 1));
      const midBatch = r.utf8Edits ? toUtf8Batches(sc.init, sc.batchesJs.slice(0, 1)) : sc.batchesJs.slice(0, 1);
      const midEdit = runEdit(r.editCmd, r.editArgs, JSON.stringify({ init: sc.init, batches: midBatch }));
      const midFresh = r.run(mid);
      const midOracle = oracleOut(mid);
      if (midEdit.ok || midFresh.ok || midOracle.ok) {
        failures++;
        console.log(`  ${r.label}: edit mid-state should reject (${sc.name}) mid=${JSON.stringify(mid)} edit=${midEdit.ok} fresh=${midFresh.ok} oracle=${midOracle.ok}`);
      }
    }
    const final = applyJs(sc.init, sc.batchesJs);
    const batches = r.utf8Edits ? toUtf8Batches(sc.init, sc.batchesJs) : sc.batchesJs;
    const payload = JSON.stringify({ init: sc.init, batches });
    const a = runEdit(r.editCmd, r.editArgs, payload);
    const b = r.run(final);
    const o = oracleOut(final);
    const finalOk = sc.expectFinalOk === undefined ? true : sc.expectFinalOk;
    if (finalOk && (!a.ok || !b.ok || !o.ok)) {
      failures++;
      console.log(`  ${r.label}: edit-session final should accept (${sc.name}) final=${JSON.stringify(final)} A ok=${a.ok} B ok=${b.ok} oracle ok=${o.ok} err=${a.err ?? ''}`);
    } else if (a.ok === b.ok && (!a.ok || a.cst === b.cst) && a.ok === o.ok) editOk++;
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
console.log(`\n✓ unicode-parity: ${ACCEPT.length} accept + ${REJECT.length} reject × ${runners.length} targets + ${EDIT.length} edits/target ≡ oracle`);
