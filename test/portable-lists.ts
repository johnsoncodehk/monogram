// Gate class of the portable targets (test/portable-harness.ts): the HAND-WRITTEN LISTS. On each
// grammar's accept / reject lists (test/portable-cases.ts) every target gives the oracle's verdict
// and, when it accepts, the oracle's rule skeleton; the jsTarget parser (emit-parser.ts) gives the
// oracle's CST byte for byte. Also: tok-spans (the token ranges each top-level kid consumed, the
// same in every target and a partition of the stream), the Unicode corpus of the javascript
// grammar, the recovery emission's default prefix, and the refusal of an entry rule that must
// choose its empty alternative.
import { writeFileSync } from 'node:fs';
import { emitParser } from '../src/target.ts';
import { jsTarget } from '../src/emit-parser.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { RESERVED_RULES } from '../src/emit-portable.ts';
import { objectify } from './emitted-obj.ts';
import { runsTarget } from './check-targets.ts';
import { cachedEmit } from './emit-cache.ts';
import { ROOT } from './gate-deps.ts';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, canon, errText, gate, finish, prepareAll, primaryLexMsg, runTokSpans, UNICODE_ACCEPT, skeleton, type EditBatch, type Outcome, type Runner } from './portable-harness.ts';

/** Reject cases. `lexMsg` set ⇒ expect that primary lexer message (≡ oracle). */
const UNICODE_REJECT: { src: string; lexMsg: string | null }[] = [
  { src: '/* abc', lexMsg: null }, // unterminated block → `/`+`*` puncts → parse reject (not a lex throw)
  { src: '`cafe', lexMsg: 'Unterminated template literal at offset 5' },
  { src: '"abc', lexMsg: 'Unexpected character at offset 0: \'"\'' },
  { src: "'abc", lexMsg: "Unexpected character at offset 0: '''" },
  { src: 'const x = `cafe', lexMsg: 'Unterminated template literal at offset 15' },
  { src: 'const x = "abc', lexMsg: 'Unexpected character at offset 10: \'"\'' },
  // each lexer error kind, and an error at the last character (an error ends the lex)
  { src: 'x = 1;"', lexMsg: 'Unexpected character at offset 6: \'"\'' },
  { src: 'a\\u002e = 1;', lexMsg: "Invalid identifier escape at offset 0: 'a\\u002e'" },
  { src: 'x = a\\u002e', lexMsg: "Invalid identifier escape at offset 4: 'a\\u002e'" },
  { src: 'x = `a\\xg`;', lexMsg: 'Invalid escape sequence in template at offset 6' },
  { src: 'x = `${a}` + `\\u{`', lexMsg: 'Invalid escape sequence in template at offset 14' },
  { src: 'x = `${`${"}`}`', lexMsg: 'Unexpected character at offset 10: \'"\'' },
  // emoji is not ID_Start; ZWSP is not JS \s — all targets must reject (messages differ in
  // encoding of the offending char across targets, so no lexMsg pin)
  { src: 'const \u{1F600} = 1;', lexMsg: null },
  { src: 'const x\u200B= 1;', lexMsg: null },
];

// init = 'const x = "café";' — JS indices: " @10, c@11, a@12, f@13, é@14, "@15, ;@16
const UNICODE_EDITS: { name: string; init: string; batches: EditBatch[]; restores?: boolean }[] = [
  { name: 'edit-before-multibyte', init: 'const x = "café";', batches: [[[14, 14, 'X']]] },
  { name: 'edit-replace-multibyte', init: 'const x = "café";', batches: [[[14, 15, 'e']]] },
  { name: 'edit-after-multibyte', init: 'const x = "café";', batches: [[[15, 15, '!']]] },
  // delete the closing backtick / `*/` → reject; restore → accept (edit ≡ fresh)
  { name: 'edit-unterm-template-restore', init: 'const x = `cafe`;', batches: [[[15, 16, '']], [[15, 15, '`']]], restores: true },
  // `/* abc ` without its `*/` lexes as `/`, `*`, `abc`: a `/` decided by text past its end (a block
  // comment attempt that fell back to division, reading to the end of the source), so no relex
  // anchor when `*/` comes back (relex-family.ts, the anchor rule).
  { name: 'edit-unterm-block-restore', init: '/* abc */\nconst a = 1;', batches: [[[7, 9, '']], [[7, 7, '*/']]], restores: true },
];

/** UTF-16 edit batches → the UTF-8 byte offsets go/rust Doc.edit takes. */
function toUtf8Batches(init: string, batches: EditBatch[]): EditBatch[] {
  const u8 = (s: string, jsIdx: number) => Buffer.byteLength(s.slice(0, jsIdx), 'utf8');
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

function unicodeParity(r: Runner, oracleOut: (src: string) => Outcome): void {
  let acc = 0, snap = 0;
  for (const src of UNICODE_ACCEPT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (!want.ok) {
      gate.failures++;
      console.log(`  javascript/unicode: oracle REJECT unexpected on ${JSON.stringify(src)}`);
      continue;
    }
    if (!got.ok) {
      gate.failures++;
      console.log(`  javascript/unicode/${r.label}: ACCEPT fail (panic/reject) on ${JSON.stringify(src)} err=${(got.err ?? '').slice(0, 240)}`);
      continue;
    }
    acc++;
    if (canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
      snap++;
      gate.failures++;
      console.log(`  javascript/unicode/${r.label}: SHAPE drift on ${JSON.stringify(src)}`);
    }
  }
  console.log(`  javascript/unicode/${r.label}: ${acc}/${UNICODE_ACCEPT.length} accept ≡ oracle${snap ? ` · ${snap} shape drift` : ''}`);

  let rej = 0;
  for (const { src, lexMsg } of UNICODE_REJECT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (want.ok || got.ok) {
      gate.failures++;
      console.log(`  javascript/unicode/${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
      continue;
    }
    if (lexMsg !== null) {
      const gotMsg = primaryLexMsg(got.err);
      const wantMsg = primaryLexMsg(want.err) ?? lexMsg;
      if (gotMsg !== wantMsg) {
        gate.failures++;
        console.log(`  javascript/unicode/${r.label}: REJECT msg drift on ${JSON.stringify(src)}\n    want ${wantMsg}\n    got  ${gotMsg ?? got.err}`);
        continue;
      }
    }
    rej++;
  }
  console.log(`  javascript/unicode/${r.label}: ${rej}/${UNICODE_REJECT.length} reject ≡ oracle`);

  let editOk = 0;
  const payload = (init: string, batches: EditBatch[]) => JSON.stringify({ init, batches: r.utf8Edits ? toUtf8Batches(init, batches) : batches });
  for (const sc of UNICODE_EDITS) {
    // After the first batch alone, an unterminated-restore case must reject.
    if (sc.restores) {
      const mid = applyEdits(sc.init, sc.batches.slice(0, 1));
      const midEdit = r.edit(payload(sc.init, sc.batches.slice(0, 1)), false);
      const midFresh = r.run(mid);
      const midOracle = oracleOut(mid);
      if (midEdit.ok || midFresh.ok || midOracle.ok) {
        gate.failures++;
        console.log(`  javascript/unicode/${r.label}: edit mid-state should reject (${sc.name}) mid=${JSON.stringify(mid)} edit=${midEdit.ok} fresh=${midFresh.ok} oracle=${midOracle.ok}`);
      }
    }
    const final = applyEdits(sc.init, sc.batches);
    const a = r.edit(payload(sc.init, sc.batches), false);
    const b = r.run(final);
    const o = oracleOut(final);
    if (!a.ok || !b.ok || !o.ok) {
      gate.failures++;
      console.log(`  javascript/unicode/${r.label}: edit-session final should accept (${sc.name}) final=${JSON.stringify(final)} A ok=${a.ok} B ok=${b.ok} oracle ok=${o.ok} err=${(a.ok ? '' : a.err ?? '').slice(0, 240)}`);
    } else if (a.cst === b.cst) editOk++;
    else {
      gate.failures++;
      console.log(`  javascript/unicode/${r.label}: edit-session mismatch (${sc.name}) final=${JSON.stringify(final)}`);
    }
  }
  console.log(`  javascript/unicode/${r.label}: ${editOk}/${UNICODE_EDITS.length} edit-sessions ≡ fresh`);
}

const RESERVED_NAMES = RESERVED_RULES.map((r) => `, ${JSON.stringify(r)}`).join('');
for (const { c, grammar, runners, oracleOut, dir, emitted } of await prepareAll()) {
  // Every module of this gate is emitted with total parsing (the emit option `recovery`), whose
  // region is appended to the default module and changes none of it but the rule-name table, which
  // names the reserved rules after the grammar's (emit-portable.ts RESERVED_RULES): each module,
  // that table read without them, begins with the default emission, byte for byte.
  for (const e of emitted) {
    if (e.rec.replace(RESERVED_NAMES, '').startsWith(e.def())) continue;
    gate.failures++;
    console.log(`  ${c.grammar}/${e.label}: the recovery emission does not begin with the default emission`);
  }

  // tok-spans: top-level kids record parse-consumption [tokStart, tokEnd); cross-target
  // identity + contiguous partition of the consumed token stream. Empty accept inputs are
  // still run (identity), but contiguous checks skip when there are no kids.
  // envspec: a Newline token spans its line break and occupies a token index like any other;
  // if contiguous ever fails here, partition by grammar with evidence rather than relaxing.
  {
    const spanRunners = runners.map((r) => ({ label: r.label, ...r.spans }));
    const spansOf = (r: (typeof spanRunners)[number], src: string) => (r.run ? r.run(src) : runTokSpans(r.cmd, r.args, src));

    const parseSpans = (out: string) => {
      const lines = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n').filter(Boolean);
      const totalLine = lines[lines.length - 1]!;
      const kids = lines.slice(0, -1).map((line) => {
        const [name, a, b] = line.split('\t');
        return { name: name!, tokStart: Number(a), tokEnd: Number(b) };
      });
      const [, , tot] = totalLine.split('\t');
      return { kids, total: Number(tot) };
    };
    const assertPartition = (src: string, out: string, label: string) => {
      const { kids, total } = parseSpans(out);
      if (kids.length === 0) {
        if (total !== 0) {
          gate.failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans empty kids but total=${total} on ${JSON.stringify(src)}`);
        }
        return;
      }
      if (kids[0]!.tokStart !== 0) {
        gate.failures++;
        console.log(`  ${c.grammar}/${label}: tok-spans first tokStart want=0 got=${kids[0]!.tokStart} on ${JSON.stringify(src)}`);
      }
      if (kids[kids.length - 1]!.tokEnd !== total) {
        gate.failures++;
        console.log(`  ${c.grammar}/${label}: tok-spans last tokEnd want=${total} got=${kids[kids.length - 1]!.tokEnd} on ${JSON.stringify(src)}`);
      }
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]!;
        if (k.tokStart > k.tokEnd) {
          gate.failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans inverted span ${k.name} [${k.tokStart},${k.tokEnd}) on ${JSON.stringify(src)}`);
        }
        if (i > 0 && kids[i - 1]!.tokEnd !== k.tokStart) {
          gate.failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans gap/overlap at kid ${i}: prevEnd=${kids[i - 1]!.tokEnd} start=${k.tokStart} on ${JSON.stringify(src)}`);
          console.log(`      spans:\n${out}`);
        }
      }
    };

    const cases = c.accept.slice(0, 2);
    for (const src of cases) {
      const outs: Array<{ label: string; out: string | null }> = spanRunners.map((r) => ({
        label: r.label,
        out: spansOf(r, src),
      }));
      const ref = outs[0]!;
      if (ref.out === null) {
        gate.failures++;
        console.log(`  ${c.grammar}/${ref.label}: tok-spans reject/fail on accept case ${JSON.stringify(src)}`);
        continue;
      }
      for (const o of outs.slice(1)) {
        if (o.out === null) {
          gate.failures++;
          console.log(`  ${c.grammar}/${o.label}: tok-spans reject/fail on accept case ${JSON.stringify(src)}`);
          continue;
        }
        if (o.out !== ref.out) {
          gate.failures++;
          console.log(`  ${c.grammar}: tok-spans cross-target mismatch ${ref.label}≢${o.label} on ${JSON.stringify(src)}`);
          console.log(`      ${ref.label}: ${JSON.stringify(ref.out)}`);
          console.log(`      ${o.label}: ${JSON.stringify(o.out)}`);
        }
      }
      for (const o of outs) {
        if (o.out !== null) assertPartition(src, o.out, o.label);
      }
    }

    if (c.grammar === 'calc') {
      const src = 'let a=1;\n2+3;\nlet b=a;';
      const out = spansOf(spanRunners[0]!, src);
      if (out === null) {
        gate.failures++;
        console.log(`  calc: tok-spans reject on trailing-punct probe`);
      } else {
        for (const r of spanRunners.slice(1)) {
          const o = spansOf(r, src);
          if (o !== out) {
            gate.failures++;
            console.log(`  calc: tok-spans cross-target mismatch on trailing-punct probe (${r.label})`);
          }
        }
        const { kids } = parseSpans(out);
        const first = kids[0];
        if (!first || first.tokEnd !== 5) {
          gate.failures++;
          console.log(`  calc: first Stmt tokEnd want=5 got=${first?.tokEnd} (name=${first?.name}) on trailing-punct probe`);
          console.log(`      spans:\n${out}`);
        } else {
          console.log(`  calc: tok-spans trailing-punct Stmt tokEnd=5 ✓`);
        }
      }
    }
    console.log(`  ${c.grammar}: tok-spans checked on ${cases.length} accept case(s)${c.grammar === 'calc' ? ' + trailing-punct probe' : ''}`);
  }

  // The jsTarget parser (emit-parser.ts, not built from the portable IR) on the same hand-written
  // lists: the oracle's verdict on each, and on each accepted input the oracle's CST byte for byte
  // (its contract, emit-parser-verify.ts). Its suppress gates (the no-`in` for-heads of
  // NO_IN_HEADS) are compiled from the grammar analysis like the portable targets', by a
  // different emitter, so they are checked here too.
  // A grammar using a mechanism the retiring jsTarget refuses BY NAME (cappedPrefix, atLevel) is
  // skipped here, saying so; any other emission error still fails.
  let jsSrc: string | null = null;
  if (runsTarget('js')) {
    try { jsSrc = cachedEmit(relative(ROOT, fileURLToPath(new URL(c.path, import.meta.url))), jsTarget.name, {}, () => emitParser(grammar, jsTarget), c.parts ?? null); } catch (e) {
      if (!/^jsTarget: /.test(errText(e))) throw e;
      console.log(`  ${c.grammar}/js: refused by the jsTarget emitter (${errText(e).split('\n')[0]})`);
    }
  }
  if (jsSrc !== null) {
    const jsFile = `${dir}/js.mts`;
    writeFileSync(jsFile, jsSrc);
    const js = await import(jsFile);
    const jsOut = (src: string): Outcome => {
      try { const r = js.parse(src); return { ok: true, cst: canon(objectify(js.tree, (fns) => js.visit(r, fns))) }; } catch (e) { return { ok: false, err: errText(e) }; }
    };
    let acc = 0, rej = 0;
    for (const src of c.accept) {
      const want = oracleOut(src), got = jsOut(src);
      if (want.ok === got.ok && (!want.ok || want.cst === (got as { cst: string }).cst)) { acc++; continue; }
      gate.failures++;
      console.log(`  ${c.grammar}/js: ACCEPT ${want.ok === got.ok ? 'CST' : 'verdict'} mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, js ok=${got.ok})`);
    }
    // A grammar whose contexts are all on demand: jsTarget keeps the shallow check (emit-parser.ts
    // shallowDemand), so a reject the context alone refuses may parse there (docs/CORRECTNESS.md).
    const shallow = grammar.targets !== undefined && Object.values(grammar.targets).every((t) => t.when === 'demand');
    let wide = 0;
    for (const src of c.reject) {
      const want = oracleOut(src), got = jsOut(src);
      if (!want.ok && !got.ok) { rej++; continue; }
      if (shallow && !want.ok) { wide++; continue; }
      gate.failures++;
      console.log(`  ${c.grammar}/js: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, js ok=${got.ok})`);
    }
    console.log(`  ${c.grammar}/js: ${acc}/${c.accept.length} accept ≡ oracle CST · ${rej}/${c.reject.length} reject ≡ oracle${wide ? ` · ${wide} taken by the shallow check (the recorded divergence)` : ''}`);
  }

  for (const r of runners) {
    let acc = 0, rej = 0, snap = 0;
    // One process per target for the whole list (the runner's batch mode: the same parse as a
    // process per input); a batch that dies (a crash on one input) falls back to one process per
    // input, so the failure names its input.
    const outs = (srcs: string[]): Outcome[] => { try { return r.batch(srcs); } catch { return srcs.map((src) => r.run(src)); } };
    const accOut = outs(c.accept), rejOut = outs(c.reject);
    for (const [i, src] of c.accept.entries()) {
      const want = oracleOut(src), got = accOut[i]!;
      if (want.ok && got.ok) {
        acc++;
        // Shape snapshot on every accepted input: the rule-node skeleton (rule labels tree,
        // trivia/punct leaves stripped) must match the oracle's. Robust to leaf-level CST
        // compression (Phase 5) but catches semantic restructure (a node becoming a different
        // rule / merging / disappearing) — e.g. the rust prefix arm once dropped its operand
        // subtree, visible only on inputs beyond the first two.
        if (src && canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
          snap++;
          gate.failures++;
          console.log(`  ${c.grammar}/${r.label}: SHAPE drift on ${JSON.stringify(src)}`);
          console.log(`      want ${canon(skeleton(want.cst)).slice(0, 160)}`);
          console.log(`      got  ${canon(skeleton(got.cst)).slice(0, 160)}`);
        }
        continue;
      }
      gate.failures++;
      console.log(`  ${c.grammar}/${r.label}: ACCEPT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
    }
    for (const [i, src] of c.reject.entries()) {
      const want = oracleOut(src), got = rejOut[i]!;
      if (!want.ok && !got.ok) { rej++; continue; }
      gate.failures++;
      console.log(`  ${c.grammar}/${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
    }
    console.log(`  ${c.grammar}/${r.label}: ${acc}/${c.accept.length} accept ≡ oracle · ${rej}/${c.reject.length} reject ≡ oracle${snap ? ` · ${snap} shape drift` : ''}`);
    // A demand context's re-parses (src/reparse-family.ts): each nested one starts inside the one
    // around it, so the work per demand operator is bounded by the nesting depth (the counter of
    // those that do not; the fixture's nested rows exercise it).
    const rp = r.demandRestarts?.();
    if (rp) {
      if (rp.overBound || !rp.restarts) { gate.failures++; console.log(`  ${c.grammar}/${r.label}: demand re-parses ${rp.restarts}, ${rp.overBound} above the bound (a nested re-parse that does not start inside the one around it)`); }
      else console.log(`  ${c.grammar}/${r.label}: ${rp.restarts} demand re-parses, none above the bound`);
    }

    if (c.grammar === 'javascript') unicodeParity(r, oracleOut);
  }
}

// A grammar the portable rendering cannot express is refused at emit time, never mis-parsed.
// Longest match takes no alternative that advances nothing, so an entry rule that has to CHOOSE
// its empty alternative (to accept the empty input) has no rendering.
{
  const { token, rule, defineGrammar, many, seq, range, star } = await import('../src/api.ts');
  const Num = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
  const Program = rule(() => [[Num, ';'], [many(Num)]]);
  const g = defineGrammar({ name: 'emptyentry', scopeName: 'source.emptyentry', tokens: { Number: Num }, prec: [], rules: { Program } });
  for (const [label, target] of ([['typescript', tsTarget], ['go', goTarget], ['rust', rustTarget]] as const).filter(([l]) => l === 'typescript' || runsTarget(l))) {
    let msg = '';
    try { emitParser(g, target); } catch (e) { msg = errText(e); }
    if (/entry rule Program has several alternatives and can match the empty input/.test(msg)) continue;
    gate.failures++;
    console.log(`  emptyentry/${label}: an entry rule with an empty alternative among several was not refused (${msg || 'emitted'})`);
  }
  console.log('  emptyentry: an entry rule that must choose its empty alternative is refused by every target');
}

finish('the hand-written lists, tok-spans, Unicode, default prefix, empty entry');
