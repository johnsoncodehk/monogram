// Gate: NOTHING A GUARD REFUSES ON A REAL INPUT COULD HAVE CHANGED THE PARSE. The portable
// parsers decide some choices without trying them: a longest-match candidate whose Guard refuses
// the buffered token (its FIRST set, its lead tests, the refusal by the complement of its FIRST:
// emit-portable.ts Guard), a candidate its Dispatch never reaches for that token, an ordered or
// predictive branch outside its FIRST set, and a star / opt / sep body outside its body guard
// (Step.guard). Each is sound only if the thing refused could not have changed the parse there:
// test/guard-lead.ts proves lead tests equal the steps they took over, test/guard-refutation.ts
// probes every refused symbol over a few short continuations. This gate closes the rest on real
// inputs: wherever a guard refuses, it ATTEMPTS the refused thing anyway, unguarded, from the very
// state the parser was in (position, children, builder, context, suppress set), and fails when
// that attempt would have changed the outcome:
//   • a longest-match candidate (rd alternative, NUD sequence or capped arm): it matches and ends
//     past the winner, or at the winner's end while declared before it (it would have won);
//   • an ordered or predictive branch: it matches before the branch that won (or none won);
//   • a star / opt / sep body: it matches non-empty (the loop would have gone on).
// The check runs on the IR, not on a target: guards are IR data, and each target renders a subset
// of them (Rust leaves body guards out of Pratt arms), so one check bounds all three. Its engine is
// an interpreter of the ParserIR that follows the portable engine step for step (the rule, Pratt
// and step shells of emit-portable.ts, as test-scale code); so that it cannot drift from what the
// targets run, every input's result is compared with the TS target's `parse` of the same text:
// accept / reject and, when accepted, the whole tree.
// Inside an attempt made for a check, further refusals are not checked (each check costs about
// one extra parse of the refused part; checking inside them would nest that cost).
//
//   node test/guard-refused.ts          [--strict-empty]   (also: GUARD_REFUSED_FILES=<n> to widen the corpus sample)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { portableIR, buildLexIdPlan, buildArenaIdPlan, isFirstGuardable, type ParserIR, type Step, type Guard, type RdRule, type PrattRule, type Dispatch, type FirstSig } from '../src/emit-portable.ts';
import { emitParser, tsTarget } from '../src/emit.ts';
import { scratchDir } from './scratch.ts';
import type { CstGrammar } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CORPUS = '/tmp/ts-repo/tests/cases/conformance';
const SAMPLE = Number(process.env.GUARD_REFUSED_FILES ?? 300);

type Tok = { kid: number; lid: number; off: number; end: number; nl: boolean };
type Cst = { rule: string; children: Cst[] } | { tokenType: string; offset: number; end: number };
// A guard that admitted a literal where what it guards then matched (and won): the gate's own
// proof that it detects a wrong refusal is to refuse that literal there and see it reported.
type Found = { body?: { step: Step; lid: number }; cand?: { guard: NonNullable<Guard>; lid: number } };
type Outcome = { accept: boolean; tree: Cst | null; checked: number; unsound: string[]; found: Found };
// The mutation: one body guard (by step) or one candidate guard (by identity) also refuses a literal.
type Mutation = { step?: Step; guard?: NonNullable<Guard>; lid: number } | null;

// ── The engine ──
// One interpreter per grammar; run(toks) parses a token list from the entry rule.
function engine(ir: ParserIR, mut: Mutation = null) {
  const ids = buildLexIdPlan(ir), ar = buildArenaIdPlan(ir, ids);
  const lidOf = (t: string) => { const i = ids.lids.indexOf(t); return i >= 0 ? i : 0; };
  const kidOf = (k: string) => { const i = ids.kids.indexOf(k); return i >= 0 ? i : 0; };
  const ttIdOf = (tt: string) => ar.ttNames.indexOf(tt);
  const PUNCT = -1, TT_KEYWORD = ttIdOf('$keyword'), TT_OPERATOR = ttIdOf('$operator');
  const GT_LID = ir.gtComps.length > 0 ? lidOf('>') : -1;
  const gtCompSet = new Set<string>(ir.gtComps);
  const gtStep = (a: number, b: number): number => { const c = ids.lids[a]! + ids.lids[b]!; return gtCompSet.has(c) ? lidOf(c) : 0; };
  const setLid = ir.tokenSets.map((s) => { const a = new Uint8Array(ids.lids.length); for (const l of s.lits) { const i = ids.lids.indexOf(l); if (i <= 0) throw new Error('lit ' + l); a[i] = 1; } return a; });
  const setKid = ir.tokenSets.map((s) => { const a = new Uint8Array(ids.kids.length); for (const k of s.toks) { const i = ids.kids.indexOf(k); if (i <= 0) throw new Error('kid ' + k); a[i] = 1; } return a; });
  const inSet = (k: number, t: Tok) => setLid[k]![t.lid] === 1 || setKid[k]![t.kid] === 1;
  const ctxWordLids = ir.ctxWords.map((w, i) => ({ bit: 1 << i, lid: lidOf(w) }));
  const firstCond = (f: NonNullable<FirstSig>, t: Tok) => f.lits.some((l) => t.lid === lidOf(l)) || f.toks.some((k) => t.kid === kidOf(k));
  const ruleByName = new Map(ir.rules.map((r) => [r.name, r]));
  const ruleId = (name: string) => ar.ruleNames.indexOf(name);
  const KID_TPL_HEAD = kidOf('$templateHead'), KID_TPL_MID = kidOf('$templateMiddle'), KID_TPL_TAIL = kidOf('$templateTail');

  // ── parser state ──
  let toks: Tok[] = [];
  let pos = 0, capped = false, form = 0, tail = false, suppressNext = 0, suppressCur = 0, ctx = 0;
  // children under construction (a node handle >= 0, a leaf < 0) and the built nodes
  const scratch: number[] = [];
  type NodeRec = { rule: number; kids: number[] };
  const nodes: NodeRec[] = [];
  type Sp = { h: number };
  let checking = 0, checked = 0;
  let unsound: string[] = [];
  let found: Found = {};

  const peek = (): Tok | null => (pos < toks.length ? toks[pos]! : null);
  const at = () => (pos < toks.length ? `offset ${toks[pos]!.off}` : 'end of input');
  // the builder's checkpoint: what a failed attempt's nodes are dropped back to
  const checkpoint = () => nodes.length;
  const restore = (ck: number) => { if (nodes.length > ck) nodes.length = ck; };
  type Mark = { pos: number; sb: number; ck: number };
  const mark = (): Mark => ({ pos, sb: scratch.length, ck: checkpoint() });
  const reset = (m: Mark) => { pos = m.pos; scratch.length = m.sb; restore(m.ck); };
  const pushLeaf = (tt: number, i: number) => { if (tt !== PUNCT) scratch.push(-(i * 256 + tt) - 1); };
  function finish(rule: number, sb: number): Sp {
    nodes.push({ rule, kids: scratch.slice(sb) });
    scratch.length = sb;
    return { h: nodes.length - 1 };
  }
  const leafTok = (h: number) => Math.floor((-h - 1) / 256);
  function headLeafText(src: string, h: number): string {
    for (;;) {
      if (h < 0) { const t = toks[leafTok(h)]!; return src.slice(t.off, t.end); }
      const nd = nodes[h]!;
      if (nd.kids.length === 0) return '';
      h = nd.kids[0]!;
    }
  }
  let src = '';
  function matchLit(lid: number, r: boolean): boolean {
    const t = peek();
    if (t !== null && t.lid === lid) { if (!r) pushLeaf(lid >= ids.kwLid ? TT_KEYWORD : PUNCT, pos); pos++; return true; }
    return false;
  }
  function gtOp(i: number): [number, number] {
    const t = toks[i]!;
    let lid = t.lid, n = 1, end = t.end;
    if (lid !== GT_LID) return [lid, n];
    for (let j = i + 1; j < toks.length; j++) {
      const u = toks[j]!;
      if (u.kid !== 0 || u.off !== end) break;
      const c = gtStep(lid, u.lid);
      if (c === 0) break;
      lid = c; n++; end = u.end;
    }
    return [lid, n];
  }
  function matchComp(lid: number): boolean {
    if (peek() === null) return false;
    const [c, n] = gtOp(pos);
    if (c !== lid) return false;
    pos += n;
    return true;
  }
  function matchTok(kid: number, r: boolean): boolean {
    const t = peek();
    if (t !== null && t.kid === kid) { if (!r) pushLeaf(kid, pos); pos++; return true; }
    return false;
  }
  const ahead = (k: number, is: boolean): boolean => { const t = peek(); return t !== null ? inSet(k, t) === is : !is; };
  const ctxWordT = (t: Tok) => ctx !== 0 && ctxWordLids.some((w) => (ctx & w.bit) !== 0 && t.lid === w.lid);
  const ctxWord = () => { const t = peek(); return t !== null && ctxWordT(t); };
  const callRule = (x: Sp | null): boolean => { if (x === null) return false; scratch.push(x.h); return true; };

  // ── checks ──
  // The state a refused attempt starts from and must leave untouched.
  const saveState = () => ({ pos, sb: scratch.length, ck: checkpoint(), ctx, capped, form, tail, suppressNext, suppressCur });
  const putState = (s: ReturnType<typeof saveState>) => { pos = s.pos; scratch.length = s.sb; restore(s.ck); ctx = s.ctx; capped = s.capped; form = s.form; tail = s.tail; suppressNext = s.suppressNext; suppressCur = s.suppressCur; };
  // Attempt `body` from here as if unrefused; the position it ends at, or -1 when it fails. The
  // parser's state is put back after.
  function attempt(body: () => boolean): number {
    const s = saveState();
    checking++;
    let end: number;
    try { end = body() ? pos : -1; } finally { checking--; putState(s); }
    return end;
  }
  const bad = (msg: string) => { if (unsound.length < 20) unsound.push(msg); else unsound.length = 20; };

  // ── steps ──
  function step(s: Step, r: boolean): boolean {
    switch (s.t) {
      case 'lit': return gtCompSet.has(s.value) ? matchComp(lidOf(s.value)) : matchLit(lidOf(s.value), r);
      case 'tok':
        if (s.hole === undefined) return matchTok(kidOf(s.name), r);
        if (matchTok(kidOf(s.name), r)) return true;
        { const sb = scratch.length; const n = matchTemplate(s.hole); if (n === null) return false; if (r) scratch.length = sb; else scratch.push(n.h); return true; }
      case 'rule': return r ? recRule(s.name) : callRule(parseRule(s.name));
      case 'ruleBp': { const sb = scratch.length; const x = prattBp(ruleByName.get(s.name) as PrattRule, s.bp); if (r) { scratch.length = sb; return x !== null; } return callRule(x); }
      case 'star': return star(s, r);
      case 'opt': return opt(s, r);
      case 'sep': return sepBy(s, r);
      case 'altlit': { for (const o of s.opts) if (matchLit(lidOf(o.value), r)) return true; return false; }
      case 'alt': return s.predictive ? predAlt(s, r) : altBody(s, r);
      case 'look': return look(s.id) === s.is;
      case 'ahead': return ahead(s.set, s.is);
      case 'aheadCtx': return s.is ? (ahead(s.set, true) || ctxWord()) : (ahead(s.set, false) && !ctxWord());
      case 'seq': return all(s.steps, r);
      case 'sameLine': { const t = peek(); return t !== null && !t.nl; }
      case 'suppress': { suppressNext = s.set; const ok = all(s.steps, r); suppressNext = 0; return ok; }
      case 'ctx': { const c0 = ctx; ctx = s.ctx; const ok = all(s.steps, r); ctx = c0; return ok; }
    }
  }
  const all = (steps: Step[], r: boolean) => { for (const x of steps) if (!step(x, r)) return false; return true; };
  // A body attempt: undone when it fails.
  const body = (f: () => boolean): boolean => { const m = mark(); if (f()) return true; reset(m); return false; };
  // A star / opt / sep body its guard refused: it must not match non-empty here.
  function bodyRefused(where: string, f: () => boolean) {
    if (checking || pos >= toks.length) return;
    checked++;
    const p0 = pos, end = attempt(f);
    if (end > p0) bad(`${where}: the body guard refuses ${at()}, but the body matches ${end - p0} token(s) there`);
  }
  // Whether a body's guard admits the next token (no guard: always).
  const bodyAdmits = (st: Step & { guard?: number }): boolean => st.guard === undefined || (ahead(st.guard, true) && !(mut?.step === st && peek()?.lid === mut.lid));
  // A guarded body attempt; one that matched non-empty from a literal is noted for the mutation proof.
  const guardedBody = (st: Step & { guard?: number }, f: () => boolean): boolean => {
    const t = peek(), p0 = pos;
    const ok = body(f);
    if (ok && pos > p0 && st.guard !== undefined && !checking && found.body === undefined && t !== null && t.lid !== 0) found.body = { step: st, lid: t.lid };
    return ok;
  };
  function star(st: Step & { t: 'star' }, r: boolean): boolean {
    for (;;) {
      if (!bodyAdmits(st)) { bodyRefused('star', () => step(st.step, r)); break; }
      if (!guardedBody(st, () => step(st.step, r))) break;
    }
    return true;
  }
  function opt(st: Step & { t: 'opt' }, r: boolean): boolean {
    if (!bodyAdmits(st)) { bodyRefused('opt', () => all(st.steps, r)); return true; }
    guardedBody(st, () => all(st.steps, r));
    return true;
  }
  function sepBy(st: Step & { t: 'sep' }, r: boolean): boolean {
    const delim = lidOf(st.delim);
    if (!bodyAdmits(st)) { bodyRefused('sep', () => step(st.elem, r)); return true; }
    if (!guardedBody(st, () => step(st.elem, r))) return true;
    // A trailing delimiter stays matched (the interpreter's matchSep).
    for (;;) {
      if (!matchLit(delim, r)) break;
      if (!body(() => step(st.elem, r))) break;
    }
    return true;
  }
  // An ordered choice: the first branch that matches. A branch its FIRST set refuses must not
  // match where it would have been tried (every earlier branch failed).
  function altBody(st: Step & { t: 'alt' }, r: boolean): boolean {
    const fs = st.firsts ?? [], n = st.branches.length;
    const t = peek();
    for (let i = 0; i < n; i++) {
      const f = fs[i] ?? null;
      if (isFirstGuardable(f, n) && !(t !== null && firstCond(f, t))) {
        if (!checking && t !== null) { checked++; if (attempt(() => all(st.branches[i]!, r)) >= 0) bad(`ordered choice: branch ${i} refused by its FIRST set at ${at()} matches there`); }
        continue;
      }
      if (body(() => all(st.branches[i]!, r))) return true;
    }
    return false;
  }
  // A predictive choice: only the branch the token's FIRST set selects; every other branch must
  // fail there, or come after the selected one when that one matches.
  function predAlt(st: Step & { t: 'alt' }, r: boolean): boolean {
    const t = peek();
    if (t === null) return false;
    const sel = st.branches.findIndex((_, i) => firstCond(st.firsts![i]!, t));
    const refusedBefore = (lim: number) => {
      if (checking) return;
      for (let j = 0; j < lim; j++) if (j !== sel) { checked++; if (attempt(() => all(st.branches[j]!, r)) >= 0) bad(`predictive choice: branch ${j} outside its FIRST set at ${at()} matches there`); }
    };
    if (sel < 0) { refusedBefore(st.branches.length); return false; }
    refusedBefore(sel);
    if (body(() => all(st.branches[sel]!, r))) return true;
    refusedBefore(st.branches.length);
    return false;
  }
  // A lookahead body runs in recognize form; everything it did is undone.
  function look(id: number): boolean {
    const m = mark();
    const ok = all(ir.lookaheads[id]!, true);
    reset(m);
    return ok;
  }

  // ── guards and dispatch ──
  const guardOk = (g: Guard, t: Tok | null, keyed: boolean): boolean => {
    if (g === null) return true;
    if (mut?.guard === g && t !== null && t.lid === mut.lid) return false;
    if (!keyed && g.first) { if (t === null || !inSet(g.first.id, t)) return false; }
    if (g.second !== null) { const i = pos + 1; if (!(i < toks.length && inSet(g.second.id, toks[i]!))) return false; }
    for (const l of g.lead) { if (t === null) return false; const x = inSet(l.set, t) || (l.ctx && ctxWordT(t)); if (x !== l.is) return false; }
    return true;
  };
  // The candidates a Dispatch reaches for token t, in trying order, each with whether it was keyed.
  function dispatchOrder(d: Dispatch, t: Tok | null): Array<{ i: number; keyed: boolean }> {
    const out: Array<{ i: number; keyed: boolean }> = [];
    for (const sec of d.sections) {
      if (sec.by === 'rest') { for (const i of sec.arms) out.push({ i, keyed: false }); continue; }
      if (t === null) continue;
      for (const g of sec.groups) {
        if ((sec.by === 'lid' ? t.lid === lidOf(g.key) : t.kid === kidOf(g.key))) { for (const i of g.arms) out.push({ i, keyed: true }); break; }
      }
    }
    return out;
  }
  // A guarded candidate that won from a literal is noted for the mutation proof.
  const note = (g: Guard, t: Tok | null) => { if (g !== null && !checking && found.cand === undefined && t !== null && t.lid !== 0) found.cand = { guard: g, lid: t.lid }; };
  // The longest-match candidates the guards refused (or the Dispatch never reached) at a list's
  // start: each, attempted unguarded from the list's start state, must not have won.
  function candidatesRefused(where: string, refused: number[], run: (i: number) => boolean, bestPos: number, bi: number, save: number) {
    if (checking || save >= toks.length) return;
    for (const i of refused) {
      checked++;
      const end = attempt(() => run(i));
      if (end > save && (end > bestPos || (end === bestPos && (bi < 0 || i < bi)))) bad(`${where}: candidate ${i} refused at offset ${toks[save]!.off} matches ${end - save} token(s) there and would have won (the winner, ${bi < 0 ? 'none' : `candidate ${bi}`}, ends at ${bestPos - save})`);
    }
  }

  // ── rules ──
  function parseRule(name: string): Sp | null {
    const r = ruleByName.get(name)!;
    if (r.kind === 'pratt') return parsePratt(r);
    if (name === ir.entry) return parseEntry(r);
    return rdRule(r, false);
  }
  function recRule(name: string): boolean {
    const r = ruleByName.get(name)!;
    if (r.kind === 'pratt') { const sb = scratch.length; const x = parsePratt(r); scratch.length = sb; return x !== null; }
    return rdRule(r, true) !== null;
  }
  // An rd rule (RuleLowering's three forms); r: recognizing (no node is built).
  function rdRule(rule: RdRule, r: boolean): Sp | null {
    const rid = ruleId(rule.name);
    const save = pos, sb = scratch.length;
    const won = (): Sp => (r ? { h: -1 } : finish(rid, sb));
    if (rule.predictive) {
      const ck = checkpoint();
      const t = peek();
      if (t === null) return null;
      const sel = rule.alts.findIndex((_, i) => firstCond(rule.altFirst[i]!, t));
      let res: Sp | null = null, end = save;
      if (sel >= 0 && all(rule.alts[sel]!, r)) { res = won(); end = pos; }
      else { pos = save; scratch.length = sb; restore(ck); }
      const p = pos;
      pos = save;
      candidatesRefused(`${rule.name} (predictive)`, rule.alts.map((_, i) => i).filter((i) => i !== sel), (i) => all(rule.alts[i]!, r), res ? end : save, res ? sel : -1, save);
      pos = p;
      return res;
    }
    if (rule.alts.length === 1) {
      const ck = checkpoint();
      if (all(rule.alts[0]!, r)) return won();
      pos = save; scratch.length = sb; restore(ck);
      return null;
    }
    const d = rule.altDispatch;
    let ck = checkpoint();
    let best: Sp | null = null, bestPos = save, bi = -1;
    const ft = rule.altGuard.some((g) => g !== null) ? peek() : null;
    const reached = new Set<number>(), refused: number[] = [];
    for (const { i, keyed } of dispatchOrder(d, ft)) {
      reached.add(i);
      const g = rule.altGuard[i]!;
      if (g !== null && !keyed && ft === null) continue;
      if (!guardOk(g, ft, keyed)) { refused.push(i); continue; }
      const ok = all(rule.alts[i]!.slice(g?.skip ?? 0), r);
      const beats = d.ranked.includes(i) ? (pos > bestPos || (pos === bestPos && i < bi)) : pos > bestPos;
      if (ok && beats) { best = won(); bestPos = pos; bi = i; ck = checkpoint(); note(g, ft); }
      else { scratch.length = sb; restore(ck); }
      pos = save;
    }
    rule.alts.forEach((_, i) => { if (!reached.has(i) && rule.altGuard[i] !== null) refused.push(i); });
    candidatesRefused(rule.name, refused, (i) => all(rule.alts[i]!, r), bestPos, bi, save);
    pos = bestPos;
    return best;
  }
  // The entry rule under its reuse plan A: each top-level entry the first of plan.rules that matches.
  function parseEntry(rule: RdRule): Sp | null {
    const plan = ir.reuse;
    if (plan === null || plan.kind !== 'A') throw new Error(`guard-refused: entry rule ${rule.name} has no reuse plan A; this engine does not run it`);
    const sb = scratch.length;
    for (;;) {
      const sp = pos;
      let got: Sp | null = null;
      for (const name of plan.rules) { got = parseRule(name); if (got !== null) break; pos = sp; }
      if (got === null) { pos = sp; break; }
      scratch.push(got.h);
    }
    return finish(ruleId(rule.name), sb);
  }

  // ── Pratt rules ──
  const pre = new Map<PrattRule, Map<number, PrattRule['prefix'][number]>>(), bin = new Map<PrattRule, Map<number, PrattRule['binary'][number]>>(), post = new Map<PrattRule, Map<number, PrattRule['postfix'][number]>>();
  const ledGroups = new Map<PrattRule, Array<{ lid: number; arms: number[] }>>();
  const postfixKids = new Map<PrattRule, Set<number>>();
  for (const r of ir.rules) {
    if (r.kind !== 'pratt') continue;
    const mp = new Map(); for (const p of r.prefix) { const l = lidOf(p.op); if (!mp.has(l)) mp.set(l, p); } pre.set(r, mp);
    const mb = new Map(); for (const b of r.binary) { const l = lidOf(b.op); if (!mb.has(l)) mb.set(l, b); } bin.set(r, mb);
    const mq = new Map(); for (const p of r.postfix) { const l = lidOf(p.op); if (!mq.has(l)) mq.set(l, p); } post.set(r, mq);
    const gs: Array<{ lid: number; arms: number[] }> = [];
    r.leds.forEach((b, i) => { const l = lidOf(b.first); let g = gs.find((x) => x.lid === l); if (!g) { g = { lid: l, arms: [] }; gs.push(g); } g.arms.push(i); });
    ledGroups.set(r, gs);
    postfixKids.set(r, new Set(r.postfixToks.map(kidOf)));
  }
  function parsePratt(r: PrattRule): Sp | null {
    const prev = suppressCur; suppressCur = suppressNext; suppressNext = 0;
    const x = prattBp(r, 0);
    suppressCur = prev;
    return x;
  }
  function matchTemplate(hole: string): Sp | null {
    const t = peek();
    if (t === null || t.kid !== KID_TPL_HEAD) return null;
    const save = pos, sb = scratch.length, ck = checkpoint();
    const fail = () => { pos = save; scratch.length = sb; restore(ck); return null; };
    pushLeaf(KID_TPL_HEAD, pos); pos++;
    for (;;) {
      const e = parseRule(hole);
      if (e === null) return fail();
      scratch.push(e.h);
      const nx = peek();
      if (nx === null) return fail();
      if (nx.kid === KID_TPL_MID) { pushLeaf(KID_TPL_MID, pos); pos++; continue; }
      if (nx.kid === KID_TPL_TAIL) { pushLeaf(KID_TPL_TAIL, pos); pos++; break; }
      return fail();
    }
    return finish(ruleId('$template'), sb);
  }
  function prattBp(r: PrattRule, minBp: number): Sp | null {
    const rid = ruleId(r.name);
    let left = prattNud(r, minBp);
    if (left === null) return null;
    let fm = form;
    if (capped) return left;
    let tailClosed = tail;
    outer: for (;;) {
      const t = peek(); if (t === null) break;
      const g = ledGroups.get(r)!.find((x) => x.lid === t.lid);
      if (g) {
        const hasBin = bin.get(r)!.has(g.lid);
        for (let j = 0; j < g.arms.length; j++) {
          const i = g.arms[j]!;
          if (r.ledAccessTail[i] && tailClosed) continue;
          const lbp = r.ledLbp[i]!;
          if (lbp !== null && !(lbp > minBp)) continue;
          if (r.ledSameLine[i] && t.nl) continue;
          const nl = r.ledNotLeftLeaf[i];
          if (nl && nl.includes(headLeafText(src, left.h))) continue;
          if (r.ledSuppressedIn[i]!.includes(suppressCur)) continue;
          const ledSave = pos, sb = scratch.length, ck = checkpoint();
          scratch.push(left.h);
          if (all(r.leds[i]!.steps, false)) {
            left = finish(rid, sb); fm = r.ledForm[i]!; if (r.ledClosesTail[i]) tailClosed = true;
            continue outer;
          }
          pos = ledSave; scratch.length = sb; restore(ck);
          if (!hasBin && j === g.arms.length - 1) break outer;
        }
      }
      if (postfixKids.get(r)!.has(t.kid) && !tailClosed) {
        const sb = scratch.length; scratch.push(left.h); pushLeaf(t.kid, pos); pos++; left = finish(rid, sb); fm = 0; continue;
      }
      if (r.postfixTplHole !== undefined && !tailClosed && t.kid === KID_TPL_HEAD) {
        const n = matchTemplate(r.postfixTplHole);
        if (n !== null) { const sb = scratch.length; scratch.push(left.h); scratch.push(n.h); left = finish(rid, sb); fm = 0; continue; }
      }
      const pq = post.get(r)!.get(t.lid);
      if (pq !== undefined && !tailClosed && pq.lbp > minBp && (!r.postfixSameLine || !t.nl)) {
        if (pq.requireTarget && fm !== 0) return null;
        const sb = scratch.length; scratch.push(left.h); pushLeaf(TT_OPERATOR, pos); pos++;
        left = finish(rid, sb); tailClosed = true; fm = 1; continue;
      }
      const [opLid, opN] = t.lid !== GT_LID ? [t.lid, 1] : gtOp(pos);
      const b = bin.get(r)!.get(opLid);
      if (b === undefined || b.lbp <= minBp) break;
      if ((b.requireTarget && fm !== 0) || (b.noUnaryLhs && fm === 2)) return null;
      const ledSave = pos, sb = scratch.length; scratch.push(left.h);
      pushLeaf(TT_OPERATOR, pos); pos += opN;
      const rhs = prattBp(r, b.rbp);
      if (rhs === null) { pos = ledSave; scratch.length = sb; break; }
      scratch.push(rhs.h);
      left = finish(rid, sb);
      fm = 1; tailClosed = true;
    }
    form = fm;
    return left;
  }
  function prattNud(r: PrattRule, minBp: number): Sp | null {
    const rid = ruleId(r.name);
    capped = false;
    const t = peek(); if (t === null) return null;
    const d = r.nudDispatch;
    const save = pos, sb = scratch.length; let ck = checkpoint();
    let best: Sp | null = null, bestPos = save, bi = -1, bf = 0, bt = false, bc = false;
    const beats = (p: number, i: number) => (d.ranked.includes(i) ? (p > bestPos || (p === bestPos && i < bi)) : p > bestPos);
    const won = (i: number, f: number, tl: boolean, cp: boolean) => { bestPos = pos; bi = i; bf = f; bt = tl; bc = cp; ck = checkpoint(); };
    const seqArm = (i: number, steps: Step[], tl: boolean, cp: boolean, g: Guard) => {
      const ok = all(steps, false);
      if (ok && beats(pos, i)) { best = finish(rid, sb); won(i, 0, tl, cp); note(g, t); }
      else { scratch.length = sb; restore(ck); }
      pos = save;
    };
    const reached = new Set<number>(), refused: number[] = [];
    for (const { i, keyed } of dispatchOrder(d, t)) {
      reached.add(i);
      const a = r.nudOrder[i]!;
      switch (a.kind) {
        case 'tok': {
          const k = r.nudToks[a.index]!;
          if ((keyed || t.kid === kidOf(k)) && beats(save + 1, i)) { pushLeaf(t.kid, pos); pos++; best = finish(rid, sb); won(i, 0, false, false); pos = save; }
          if (r.nudTplHole !== undefined && ir.tpl && k === ir.tpl.token && t.kid === KID_TPL_HEAD) {
            const n = matchTemplate(r.nudTplHole);
            if (n !== null && beats(pos, i)) { scratch.push(n.h); best = finish(rid, sb); won(i, 0, false, false); }
            else { scratch.length = sb; restore(ck); }
            pos = save;
          }
          break;
        }
        case 'bracket': {
          const b = r.nudBrackets[a.index]!;
          if (!keyed && t.lid !== lidOf(b.first)) break;
          seqArm(i, b.steps, r.nudBracketClosesTail[a.index]!, false, null);
          break;
        }
        case 'seq': {
          const g = r.nudSeqGuard[a.index]!;
          if (!guardOk(g, t, keyed)) { refused.push(i); break; }
          seqArm(i, r.nudSeqs[a.index]!.slice(g?.skip ?? 0), r.nudSeqClosesTail[a.index]!, false, g);
          break;
        }
        case 'capped': {
          const c = r.nudCapped[a.index]!;
          if (!(minBp < c.capBp)) break;
          const g = r.nudCappedGuard[a.index]!;
          if (!guardOk(g, t, keyed)) { refused.push(i); break; }
          seqArm(i, c.steps.slice(g?.skip ?? 0), false, true, g);
          break;
        }
        case 'prefix': {
          const p = pre.get(r)!.get(t.lid);
          if (p === undefined) break;
          pushLeaf(TT_OPERATOR, pos); pos++;
          const operand = prattBp(r, p.rbp);
          // A prefix operator whose operand must be a target fails the whole call.
          if (operand !== null && p.requireTarget && form !== 0) { pos = save; scratch.length = sb; restore(ck); capped = false; return null; }
          if (operand !== null && beats(pos, i)) { scratch.push(operand.h); best = finish(rid, sb); won(i, p.form, true, false); }
          else { scratch.length = sb; restore(ck); }
          pos = save;
          break;
        }
      }
    }
    // A sequence or capped arm the Dispatch did not reach for this token is refused by its key.
    r.nudOrder.forEach((a, i) => {
      if (reached.has(i)) return;
      if (a.kind === 'seq' && r.nudSeqGuard[a.index] !== null) refused.push(i);
      if (a.kind === 'capped' && minBp < r.nudCapped[a.index]!.capBp && r.nudCappedGuard[a.index] !== null) refused.push(i);
    });
    const armSteps = (i: number): Step[] => { const a = r.nudOrder[i]!; return a.kind === 'seq' ? r.nudSeqs[a.index]! : r.nudCapped[(a as { index: number }).index]!.steps; };
    candidatesRefused(`${r.name} NUD`, refused, (i) => all(armSteps(i), false), bestPos, bi, save);
    capped = bc; form = bf; tail = bt;
    pos = bestPos;
    return best;
  }

  // The tree in the CST's form (TS target `parse`): a node's rule and children, a leaf's type and span.
  function tree(h: number): Cst {
    if (h < 0) { const v = -h - 1, t = toks[Math.floor(v / 256)]!; return { tokenType: ar.ttNames[v % 256]!, offset: t.off, end: t.end }; }
    const nd = nodes[h]!;
    return { rule: ar.ruleNames[nd.rule]!, children: nd.kids.map(tree) };
  }
  return function run(tokens: Tok[], text: string): Outcome {
    toks = tokens; src = text;
    pos = 0; capped = false; form = 0; tail = false; suppressNext = 0; suppressCur = 0; ctx = 0;
    scratch.length = 0; nodes.length = 0; checked = 0; unsound = []; found = {};
    const root = parseRule(ir.entry);
    const accept = root !== null && pos === toks.length;
    return { accept, tree: accept ? tree(root!.h) : null, checked, unsound, found };
  };
}

// The TS target's tree with what the engine does not model left out: node spans.
function canon(c: any): Cst {
  return 'rule' in c ? { rule: c.rule, children: c.children.map(canon) } : { tokenType: c.tokenType, offset: c.offset, end: c.end };
}

// ── inputs ──
function filesUnder(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (ext.test(e.name)) out.push(p); } };
  walk(dir);
  return out;
}
const stride = <T>(xs: T[], n: number): T[] => (xs.length <= n ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / n) === 0));
const corpus = stride(filesUnder(CORPUS, /\.tsx?$/).filter((f) => !f.endsWith('.tsx') && statSync(f).size < 20000), SAMPLE);
if (corpus.length === 0) { console.log(`guard-refused: NOT RUN: the conformance corpus ${CORPUS} is missing`); process.exit(1); }
const NM = `${ROOT}node_modules`;
const tsInputs = [
  ...readdirSync(`${ROOT}src`).filter((f) => f.endsWith('.ts')).map((f) => `${ROOT}src/${f}`),
  ...readdirSync(ROOT).filter((f) => f.endsWith('.ts')).map((f) => `${ROOT}${f}`),
  `${NM}/typescript/lib/typescript.d.ts`, `${NM}/typescript/lib/lib.es5.d.ts`,
  ...corpus,
];
const jsInputs = [
  `${NM}/acorn/dist/acorn.mjs`,
  ...filesUnder(`${NM}/parse5/dist`, /\.js$/), ...filesUnder(`${NM}/entities/dist`, /\.js$/), ...filesUnder(`${NM}/yaml/dist`, /\.js$/),
  ...corpus,
];

let failures = 0;
const t0 = Date.now();
const dir = scratchDir('guard-refused');
for (const [g, inputs] of [['typescript', tsInputs], ['javascript', jsInputs]] as const) {
  const grammar: CstGrammar = (await import(`${ROOT}${g}.ts`)).default;
  const ir = portableIR(grammar);
  const file = `${dir}/${g}.ts`;
  writeFileSync(file, emitParser(grammar, tsTarget));
  const lib = await import(file) as { tokenize(s: string): Tok[]; parse(s: string): unknown };
  const run = engine(ir);
  let n = 0, accepted = 0, checks = 0, drift = 0, bad = 0;
  const proof: { body?: { at: string; tokens: Tok[]; text: string; m: Mutation }; cand?: { at: string; tokens: Tok[]; text: string; m: Mutation } } = {};
  for (const path of inputs) {
    const text = readFileSync(path, 'utf8');
    let tokens: Tok[];
    try { tokens = lib.tokenize(text).map((t) => ({ kid: t.kid, lid: t.lid, off: t.off, end: t.end, nl: t.nl })); } catch { continue; }
    n++;
    const want = lib.parse(text);
    const got = run(tokens, text);
    checks += got.checked;
    if (got.accept) accepted++;
    const name = path.startsWith(ROOT) ? path.slice(ROOT.length) : path.slice(CORPUS.length - 'conformance'.length);
    if (got.accept !== (want !== null) || (got.accept && JSON.stringify(got.tree) !== JSON.stringify(canon(want)))) {
      drift++;
      if (drift <= 5) console.log(`  DRIFT ${g} ${name}: the engine ${got.accept ? 'accepts' : 'rejects'}, the TS target ${want !== null ? 'accepts' : 'rejects'}${got.accept && want !== null ? ' with another tree' : ''}`);
    }
    for (const u of got.unsound) { bad++; if (bad <= 12) console.log(`  FAIL ${g} ${name}: ${u}`); }
    if (!proof.body && got.found.body) proof.body = { at: name, tokens, text, m: { step: got.found.body.step, lid: got.found.body.lid } };
    if (!proof.cand && got.found.cand) proof.cand = { at: name, tokens, text, m: { guard: got.found.cand.guard, lid: got.found.cand.lid } };
  }
  // The mutation proof: a body guard, then a candidate guard, made to refuse a literal it admitted
  // where its body / candidate matched; the gate must report it on that input.
  const ids = buildLexIdPlan(ir);
  for (const kind of ['body', 'cand'] as const) {
    const p = proof[kind];
    if (!p) { console.log(`  FAIL ${g}: no ${kind === 'body' ? 'guarded body' : 'guarded candidate'} matched from a literal: the mutation proof has nothing to mutate`); failures++; continue; }
    const caught = engine(ir, p.m)(p.tokens, p.text).unsound.length;
    console.log(`  ${g}: mutation: the ${kind === 'body' ? 'body guard' : 'candidate guard'} that admitted ${JSON.stringify(ids.lids[p.m!.lid])} in ${p.at} made to refuse it: ${caught} unsound refusal(s) reported`);
    if (caught === 0) { console.log(`  FAIL ${g}: the mutated guard was not caught`); failures++; }
  }
  failures += drift + bad;
  console.log(`  ${g}: ${n} inputs (${accepted} accepted), ${checks} refusals attempted, ${bad} would have changed the parse, ${drift} differ from the TS target`);
  if (checks === 0) { console.log(`  FAIL ${g}: no refusal was attempted: the gate checks nothing`); failures++; }
}
console.log(`guard-refused: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failures} failures`);
process.exit(failures ? 1 : 0);
