// The ParserIR engine of test/guard-refused.ts: an interpreter of the ParserIR that follows the
// portable engine step for step (the rule, Pratt and step shells of emit-portable.ts, as test-scale
// code), with the checks guard-refused makes at every refusal and every elided mark. Its own module
// so that test/decision-report.ts runs the same engine to observe which longest-match lists TIE
// (two candidates end at the same token: declaration order decides) on real inputs.
import { buildLexIdPlan, buildArenaIdPlan, isFirstGuardable, type ParserIR, type Step, type Guard, type RdRule, type PrattRule, type Dispatch, type FirstSig, type Commit, type CommitAct, type CommitTest } from '../src/emit-portable.ts';
export type Tok = { kid: number; lid: number; off: number; end: number; nl: boolean };
export type Cst = { rule: string; children: Cst[] } | { tokenType: string; offset: number; end: number };
// A guard that admitted a literal where what it guards then matched (and won): the gate's own
// proof that it detects a wrong refusal is to refuse that literal there and see it reported.
export type Found = { body?: { step: Step; lid: number }; cand?: { guard: NonNullable<Guard>; lid: number; pos: number }; commit?: { list: string; lid: number; kid: number; arm: number }; dirty?: { step: Step; i: number }; built?: { step: Step }; pair?: { guard: NonNullable<Guard>; pos: number; lid: number } };
export type Outcome = { accept: boolean; tree: Cst | null; checked: number; cleanChecked: number; leavesChecked: number; unsound: string[]; found: Found };
// The mutation: one body guard (by step) or one candidate guard (by identity, at the one list start
// `pos` where it won: refused at every token with that literal, a nested element of the same
// list would also be refused inside the check's own attempt) also refuses a literal,
// or one list commits, at one token (lid and kid), to another candidate than its plan's (`commit`).
// Or (`clean`) one frame whose body is not clean is taken for clean: a branch (`i`) of an ordered or
// predictive choice, or a star / opt / sep body (`i` -1). Or (`leaves`) one star / opt / sep body
// under a full mark is taken to fail with leaves only (Step.leaves).
export type Mutation = { step?: Step; guard?: NonNullable<Guard>; lid: number; pos?: number; commit?: { list: string; kid: number; arm: number }; clean?: { step: Step; i: number }; leaves?: Step; pair?: { guard: NonNullable<Guard>; pos: number } } | null;
// Or (`pair`) one guard's pair tests (Guard.pairs) refuse at the one list start where they admitted the
// candidate that won.

// ── The engine ──
// One interpreter per grammar; run(toks) parses a token list from the entry rule.
// What a run reports beyond its checks: `onTie` is called at every longest-match frame (an rd rule's
// alternatives, a Pratt rule's NUD arms) where a candidate other than the winner ends where the
// winner ends (declaration order decided between them), outside the attempts the checks make;
// `check: false` makes no check at all (no refused candidate, body or branch is attempted), so a run
// costs one parse.
export type Observer = { onTie?: (list: string, winner: number, loser: number, at: number) => void; check?: boolean };
export function engine(ir: ParserIR, mut: Mutation = null, obs: Observer = {}) {
  const ids = buildLexIdPlan(ir), ar = buildArenaIdPlan(ir, ids);
  const lidOf = (t: string) => { const i = ids.lids.indexOf(t); return i >= 0 ? i : 0; };
  const kidOf = (k: string) => { const i = ids.kids.indexOf(k); return i >= 0 ? i : 0; };
  const ttIdOf = (tt: string) => ar.ttNames.indexOf(tt);
  const PUNCT = -1, TT_KEYWORD = ttIdOf('$keyword'), TT_OPERATOR = ttIdOf('$operator');
  const GT_LEADS = new Set(ir.gtComps.map((c) => lidOf(c[0]!)));   // the composites' leads ('>', '<': compositeLeads)
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
  const base = obs.check === false ? 1 : 0;   // `checking` above it: inside a check's attempt
  let checking = base, checked = 0, cleanChecked = 0, leavesChecked = 0;
  // The candidates of one frame that matched non-empty, with their ends: ties are those ending at the winner's end.
  const noteTies = (list: string, ends: Array<[number, number]>, bestPos: number, bi: number, save: number) => {
    if (obs.onTie === undefined || checking !== base || bi < 0) return;
    for (const [i, e] of ends) if (i !== bi && e === bestPos) obs.onTie(list, Math.min(i, bi), Math.max(i, bi), save);
  };
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
  // A binary operator composed of several `>` tokens: its leaf spans them (by its first token).
  const opEnd = new Map<number, number>();
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
    if (!GT_LEADS.has(lid)) return [lid, n];
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

  const guardSteps = (g: Guard, steps: Step[]): Step[] => steps.slice(g?.skip ?? 0);
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
  // ── elided marks ──
  // The state a body that fails clean must leave as it found it: what a mark puts back (position,
  // scratch list, nodes) and the context and suppress sets (their steps put them back on either
  // outcome). capped / form / tail are not in it: they describe the last Pratt call's node, are
  // read only right after a call that matched, and no mark puts them back.
  const stateKey = () => `${pos},${scratch.length},${nodes.length},${ctx},${suppressNext},${suppressCur}`;
  // The step after each step of every step list (what follows a repetition, which may doom its body).
  const nextOf = new Map<Step, Array<Step | undefined>>();
  {
    const lists: Step[][] = [...ir.lookaheads];
    for (const r of ir.rules) {
      if (r.kind === 'rd') lists.push(...r.alts);
      else lists.push(...r.nudBrackets.map((b) => b.steps), ...r.nudSeqs, ...r.nudCapped.map((c) => c.steps), ...r.leds.map((b) => b.steps));
    }
    const walk = (l: Step[]): void => l.forEach((s, k) => {
      const a = nextOf.get(s); if (a) a.push(l[k + 1]); else nextOf.set(s, [l[k + 1]]);
      if (s.t === 'star') walk([s.step]); else if (s.t === 'sep') walk([s.elem]);
      else if (s.t === 'opt' || s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') walk(s.steps);
      else if (s.t === 'alt') s.branches.forEach(walk);
    });
    lists.forEach(walk);
  }
  // `f` runs where the plan takes no mark; failing, it must leave the state it found (`what`
  // names the site). A dirty failure of a repetition body (`rep`, the repetition) is allowed only
  // where every step that follows the repetition fails from there: the list then fails, and the
  // frame that runs it undoes it.
  function elided(what: string, f: () => boolean, rep?: Step, r = false): boolean {
    if (checking) return f();
    const k0 = stateKey(), p0 = pos;
    const ok = f();
    if (ok) return true;
    cleanChecked++;
    if (stateKey() !== k0) {
      const nexts = rep === undefined ? [] : nextOf.get(rep) ?? [undefined];
      const doomed = nexts.length > 0 && nexts.every((n) => n !== undefined && attempt(() => step(n, r)) < 0);
      if (!doomed) bad(`${what}: marked clean, it failed at ${at()} (it started at offset ${toks[p0]?.off ?? 'end'}) and left the state changed (${k0} -> ${stateKey()})`);
    }
    return false;
  }

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
  // A body attempt: undone when it fails. A clean one (Step.clean) takes no mark in the targets; one
  // that fails with leaves only (Step.leaves) a mark of the position and the scratch list alone.
  const body = (f: () => boolean, st?: Step & { clean?: true; leaves?: true }, r = false): boolean => {
    const m = mark();
    if (st === undefined) { if (f()) return true; reset(m); return false; }
    if (st.clean || (mut?.clean?.step === st && mut.clean.i < 0) ? elided(`${st.t} body`, f, st.clean ? st : undefined, r) : st.leaves || mut?.leaves === st ? leavesOnly(st, f) : noteDirty(st, -1, f)) return true;
    reset(m); return false;
  };
  // `f` runs under a mark that saves the position and the scratch list only (MarkForm 'leaves'):
  // failing, it must have left everything else as it found it, the builder's nodes above all
  // (what the full mark's checkpoint would have dropped), and the context and suppress sets.
  function leavesOnly(st: Step, f: () => boolean): boolean {
    if (checking) return f();
    const key = () => `${nodes.length},${ctx},${suppressNext},${suppressCur}`;
    const k0 = key(), n0 = nodes.length, p0 = pos, s0 = stateKey();
    const ok = f();
    if (ok) return true;
    leavesChecked++;
    if (stateKey() !== s0) found.dirty ??= { step: st, i: -1 };   // the elided-mark proof may take it for clean
    if (key() !== k0) bad(`${st.t} body: marked to fail with leaves only, it failed at ${at()} (it started at offset ${toks[p0]?.off ?? 'end'}) with ${nodes.length - n0} node(s) built (${k0} -> ${key()})`);
    return false;
  }
  // A frame body that is not clean and fails dirty: noted for the mutation proof.
  // A star / opt / sep body that is not clean and fails with a node built: noted for the
  // mutation proof of the leaves-only mark.
  function noteDirty(st: Step, i: number, f: () => boolean): boolean {
    if (checking || (found.dirty !== undefined && (i >= 0 || found.built !== undefined))) return f();
    const k0 = stateKey(), n0 = nodes.length, ok = f();
    if (!ok && stateKey() !== k0) found.dirty ??= { step: st, i };
    if (!ok && i < 0 && nodes.length !== n0) found.built ??= { step: st };
    return ok;
  }
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
  const guardedBody = (st: Step & { guard?: number; clean?: true }, f: () => boolean, r = false): boolean => {
    const t = peek(), p0 = pos;
    const ok = body(f, st, r);
    if (ok && pos > p0 && st.guard !== undefined && !checking && found.body === undefined && t !== null && t.lid !== 0) found.body = { step: st, lid: t.lid };
    return ok;
  };
  function star(st: Step & { t: 'star' }, r: boolean): boolean {
    for (;;) {
      if (!bodyAdmits(st)) { bodyRefused('star', () => step(st.step, r)); break; }
      if (!guardedBody(st, () => step(st.step, r), r)) break;
    }
    return true;
  }
  function opt(st: Step & { t: 'opt' }, r: boolean): boolean {
    if (!bodyAdmits(st)) { bodyRefused('opt', () => all(st.steps, r)); return true; }
    guardedBody(st, () => all(st.steps, r), r);
    return true;
  }
  function sepBy(st: Step & { t: 'sep' }, r: boolean): boolean {
    const delim = lidOf(st.delim);
    if (!bodyAdmits(st)) { bodyRefused('sep', () => step(st.elem, r)); return true; }
    if (!guardedBody(st, () => step(st.elem, r), r)) return true;
    // A trailing delimiter stays matched (the interpreter's matchSep).
    for (;;) {
      if (!matchLit(delim, r)) break;
      if (!body(() => step(st.elem, r), st, r)) break;
    }
    return true;
  }
  // An ordered choice: the first branch that matches. A branch its FIRST set refuses must not
  // match where it would have been tried (every earlier branch failed).
  // A branch the plan marks clean has no frame (the mutation takes one more for clean); one that
  // is not clean and fails dirty is noted for the mutation proof.
  const branchClean = (st: Step & { t: 'alt' }, i: number) => st.clean?.[i] === true || (mut?.clean?.step === st && mut.clean.i === i);
  const branch = (st: Step & { t: 'alt' }, i: number, r: boolean): boolean => {
    const f = () => all(st.branches[i]!, r);
    if (branchClean(st, i)) return body(() => elided(`${st.predictive ? 'predictive' : 'ordered'} branch ${i}`, f));
    return body(() => noteDirty(st, i, f));
  };
  function altBody(st: Step & { t: 'alt' }, r: boolean): boolean {
    const fs = st.firsts ?? [], n = st.branches.length;
    const t = peek();
    for (let i = 0; i < n; i++) {
      const f = fs[i] ?? null;
      if (isFirstGuardable(f, n) && !(t !== null && firstCond(f, t))) {
        if (!checking && t !== null) { checked++; if (attempt(() => all(st.branches[i]!, r)) >= 0) bad(`ordered choice: branch ${i} refused by its FIRST set at ${at()} matches there`); }
        continue;
      }
      if (branch(st, i, r)) return true;
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
    if (branch(st, sel, r)) return true;
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
  // A pair test (Guard.pairs): where the first token is in `when`, the token after it in `second`.
  const pairOk = (x: { when: { id: number }; second: { id: number } }, t: Tok | null, g?: Guard) => t === null || !inSet(x.when.id, t)
    || (!(mut?.pair && mut.pair.guard === g && mut.pair.pos === pos) && pos + 1 < toks.length && inSet(x.second.id, toks[pos + 1]!));
  // A winner admitted by one of its pair tests (its first token in the pair's `when`): noted for the mutation proof.
  const notePair = (g: Guard, t: Tok | null) => { if (g !== null && g.pairs && !checking && found.pair === undefined && t !== null && g.pairs.some((x) => inSet(x.when.id, t))) found.pair = { guard: g, pos, lid: t.lid }; };
  const guardOk = (g: Guard, t: Tok | null, keyed: boolean): boolean => {
    if (g === null) return true;
    if (mut?.guard === g && t !== null && t.lid === mut.lid && pos === mut.pos) return false;
    if (!keyed && g.first) { if (t === null || !inSet(g.first.id, t)) return false; }
    if (g.second !== null) { const i = pos + 1; if (!(i < toks.length && inSet(g.second.id, toks[i]!))) return false; }
    for (const l of g.lead) { if (t === null) return false; const x = inSet(l.set, t) || (l.ctx && ctxWordT(t)); if (x !== l.is) return false; }
    for (const x of g.pairs ?? []) if (!pairOk(x, t, g)) return false;
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
  // A guarded candidate that won its list from a literal (the list's winner, not a best that a
  // later candidate beat: refusing that one changes nothing) is noted for the mutation proof.
  const note = (g: Guard, t: Tok | null) => { notePair(g, t); if (g !== null && !checking && found.cand === undefined && t !== null && t.lid !== 0) found.cand = { guard: g, lid: t.lid, pos }; };
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

  // ── committed choices ──
  // The action a Commit takes at t ('frame': the frame decides), with the mutation applied: its list
  // commits at that token to another candidate, tested by its whole guard (`all`).
  type Act = CommitAct & { all?: true };
  function commitAct(list: string, c: Commit, t: Tok): Act | null | 'frame' {
    const lc = t.lid !== 0 ? c.lid.find((x) => x.keys.includes(ids.lids[t.lid]!)) : undefined;
    const kc = lc !== undefined ? undefined : c.kid.find((x) => x.keys.includes(ids.kids[t.kid]!));
    const act = lc !== undefined ? lc.act : kc !== undefined ? kc.act : 'frame';
    const m = mut?.commit;
    if (m && m.list === list && t.lid === mut!.lid && t.kid === m.kid && act !== null && act !== 'frame') return { arm: m.arm, first: true, lead: [], nullable: true, clean: false, unless: [], all: true };
    return act;
  }
  // A candidate's run-time tests at a key (CommitTest); `all`: its whole guard.
  const rdTest = (g: Guard, x: CommitTest & { all?: true }, t: Tok): boolean => {
    if (g === null) return true;
    if (x.all) return guardOk(g, t, false);
    if (x.first && !inSet(g.first!.id, t)) return false;
    if (g.second !== null) { const i = pos + 1; if (!(i < toks.length && inSet(g.second.id, toks[i]!))) return false; }
    for (const k of x.lead) { const l = g.lead[k]!; const v = inSet(l.set, t) || (l.ctx && ctxWordT(t)); if (v !== l.is) return false; }
    for (const k of x.pairs ?? []) if (!pairOk(g.pairs![k]!, t, g)) return false;
    return true;
  };
  const noteCommit = (list: string, t: Tok, arm: number, n: number) => {
    if (!checking && found.commit === undefined && t.lid !== 0 && n > 1) found.commit = { list, lid: t.lid, kid: t.kid, arm: arm === 0 ? 1 : 0 };
  };

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
      if (sel >= 0 && (rule.clean ? elided(`${rule.name} (predictive, clean)`, () => all(rule.alts[sel]!, r)) : all(rule.alts[sel]!, r))) { res = won(); end = pos; }
      else { pos = save; scratch.length = sb; restore(ck); }
      const p = pos;
      pos = save;
      candidatesRefused(`${rule.name} (predictive)`, rule.alts.map((_, i) => i).filter((i) => i !== sel), (i) => all(rule.alts[i]!, r), res ? end : save, res ? sel : -1, save);
      pos = p;
      return res;
    }
    if (rule.alts.length === 1) {
      const ck = checkpoint();
      if (rule.clean ? elided(`${rule.name} (clean)`, () => all(rule.alts[0]!, r)) : all(rule.alts[0]!, r)) return won();
      pos = save; scratch.length = sb; restore(ck);
      return null;
    }
    const runAlt = (i: number) => all(rule.alts[i]!, r);
    const every = rule.alts.map((_, i) => i);
    const t0 = peek();
    if (rule.altCommit !== undefined && t0 !== null) {
      const act = commitAct(rule.name, rule.altCommit, t0);
      if (act === null) { candidatesRefused(`${rule.name} (no candidate at this key)`, every, runAlt, save, -1, save); return null; }
      if (act !== 'frame' && !act.unless.some((u) => rdTest(rule.altGuard[u.arm]!, u, t0))) {
        const i = act.arm, g = rule.altGuard[i]!;
        let res: Sp | null = null, end = save;
        if (rdTest(g, act, t0)) {
          const ck = checkpoint();
          const run = () => all(rule.alts[i]!.slice(g?.skip ?? 0), r);
          if ((act.clean && !act.nullable ? elided(`${rule.name} (committed to ${i}, clean)`, run) : run()) && (!act.nullable || pos > save)) { res = won(); end = pos; noteCommit(rule.name, t0, i, rule.alts.length); const p = pos; pos = save; notePair(g, t0); pos = p; }
          else { pos = save; scratch.length = sb; restore(ck); }
        }
        pos = save;
        candidatesRefused(`${rule.name} (committed to ${i})`, every.filter((j) => res === null || j !== i), runAlt, end, res ? i : -1, save);
        pos = end;
        return res;
      }
    }
    const d = rule.altDispatch;
    let ck = checkpoint();
    let best: Sp | null = null, bestPos = save, bi = -1, bg: Guard = null;
    const ft = rule.altGuard.some((g) => g !== null) ? peek() : null;
    const reached = new Set<number>(), refused: number[] = [], ends: Array<[number, number]> = [];
    for (const { i, keyed } of dispatchOrder(d, ft)) {
      reached.add(i);
      const g = rule.altGuard[i]!;
      if (g !== null && !keyed && ft === null) continue;
      if (!guardOk(g, ft, keyed)) { refused.push(i); continue; }
      const ok = all(rule.alts[i]!.slice(g?.skip ?? 0), r);
      if (ok && pos > save) ends.push([i, pos]);
      const beats = d.ranked.includes(i) ? (pos > bestPos || (pos === bestPos && i < bi)) : pos > bestPos;
      if (ok && beats) { best = won(); bestPos = pos; bi = i; ck = checkpoint(); bg = g; }
      else { scratch.length = sb; restore(ck); }
      pos = save;
    }
    rule.alts.forEach((_, i) => { if (!reached.has(i) && rule.altGuard[i] !== null) refused.push(i); });
    if (best !== null) note(bg, ft);
    noteTies(rule.name, ends, bestPos, bi, save);
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
  // A led's mixfix operand re-bind (PrattRule.ledRebind): its steps are the connector, the operand,
  // L2, the rest. The cap is the token stream ending at the candidate.
  const BR_OPEN = ['(', '[', '{'].map(lidOf).filter((x) => x !== 0), BR_CLOSE = [')', ']', '}'].map(lidOf).filter((x) => x !== 0);
  function rebind(st: Step[], sepLid: number): boolean {
    const s = pos, ss = scratch.length, cs = checkpoint();
    const undo = (p: number, sl: number, c: number) => { pos = p; scratch.length = sl; restore(c); };
    if (!step(st[0]!, false)) { undo(s, ss, cs); return false; }
    const a = pos, sa = scratch.length, ca = checkpoint();
    if (!step(st[1]!, false) || step(st[2]!, false)) { undo(s, ss, cs); return false; }
    const g = pos;
    for (let i = a, depth = 0; i < g; i++) {
      const l = toks[i]!.lid;
      if (BR_OPEN.includes(l)) depth++;
      else if (BR_CLOSE.includes(l)) depth--;
      else if (depth === 0 && l === sepLid) {
        undo(a, sa, ca);
        const full = toks;
        toks = full.slice(0, i);
        const ok = step(st[1]!, false);
        toks = full;
        if (ok && pos === i && step(st[2]!, false) && all(st.slice(3), false)) return true;
      }
    }
    undo(s, ss, cs);
    return false;
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
          // A clean led arm (PrattRule.ledClean) takes no builder checkpoint: failing, it must have built no node.
          const runLed = () => all(r.leds[i]!.steps, false);
          const ledOk = r.ledClean[i] && !checking ? (() => {
            const n0 = nodes.length, ok = runLed();
            if (!ok) { cleanChecked++; if (nodes.length !== n0) bad(`${r.name} led ${i} (${r.leds[i]!.first}): marked clean, it failed at ${at()} with ${nodes.length - n0} node(s) built`); }
            return ok;
          })() : runLed();
          // Matched: capped by its trailing operand (PrattRule.ledCapsFromTail), the node returns at once, still capped.
          if (ledOk) {
            left = finish(rid, sb); fm = r.ledForm[i]!;
            if (r.ledCapsFromTail[i] && capped) { form = fm; return left; }
            if (r.ledClosesTail[i]) tailClosed = true;
            continue outer;
          }
          pos = ledSave; scratch.length = sb; restore(ck);
          const sep = r.ledRebind[i];
          if (sep != null) {
            scratch.push(left.h);
            if (rebind(r.leds[i]!.steps, lidOf(sep))) {
              left = finish(rid, sb); fm = r.ledForm[i]!;
              if (r.ledCapsFromTail[i] && capped) { form = fm; return left; }
              if (r.ledClosesTail[i]) tailClosed = true;
              continue outer;
            }
            scratch.length = sb;
          }
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
      const [opLid, opN] = !GT_LEADS.has(t.lid) ? [t.lid, 1] : gtOp(pos);
      const b = bin.get(r)!.get(opLid);
      if (b === undefined || b.lbp <= minBp) break;
      if ((b.requireTarget && fm !== 0) || (b.noUnaryLhs && fm === 2)) return null;
      const ledSave = pos, sb = scratch.length; scratch.push(left.h);
      pushLeaf(TT_OPERATOR, pos); if (opN > 1) opEnd.set(pos, toks[pos + opN - 1]!.end); pos += opN;
      const rhs = prattBp(r, b.rbp);
      if (rhs === null) { pos = ledSave; scratch.length = sb; break; }
      scratch.push(rhs.h);
      left = finish(rid, sb);
      if (capped) { form = 1; return left; }   // a capped right operand caps this node (PrattLowering.binary)
      fm = 1; tailClosed = true;
    }
    capped = false;   // a sub-parse's capped flag is not this node's (PrattLowering.bpClose)
    form = fm;
    return left;
  }
  function prattNud(r: PrattRule, minBp: number): Sp | null {
    const rid = ruleId(r.name);
    capped = false;
    const t = peek(); if (t === null) return null;
    const d = r.nudDispatch;
    const save = pos, sb = scratch.length; let ck = checkpoint();
    let best: Sp | null = null, bestPos = save, bi = -1, bf = 0, bt = false, bc = false, bg: Guard = null;
    const beats = (p: number, i: number) => (d.ranked.includes(i) ? (p > bestPos || (p === bestPos && i < bi)) : p > bestPos);
    const won = (i: number, f: number, tl: boolean, cp: boolean) => { bestPos = pos; bi = i; bf = f; bt = tl; bc = cp; ck = checkpoint(); bg = null; };
    const ends: Array<[number, number]> = [];
    // fromTail: the arm takes its trailing operand's capped flag (PrattRule.nudSeqCapsFromTail).
    const seqArm = (i: number, steps: Step[], tl: boolean, cp: boolean, g: Guard, fromTail = false, fm = 0) => {
      const ok = all(steps, false);
      if (ok && pos > save) ends.push([i, pos]);
      if (ok && beats(pos, i)) { best = finish(rid, sb); won(i, fm, tl, cp || (fromTail && capped)); bg = g; }
      else { scratch.length = sb; restore(ck); }
      pos = save;
    };
    if (r.nudCommit !== undefined) {
      const act = commitAct(r.name, r.nudCommit, t);
      // Every arm that is a candidate at all here (a capped arm only below its binding power),
      // attempted unguarded: whether it matches.
      const arms = r.nudOrder.map((_, i) => i).filter((i) => { const a = r.nudOrder[i]!; return a.kind !== 'capped' || minBp < r.nudCapped[a.index]!.capBp; });
      const runArm = (i: number): boolean => {
        const a = r.nudOrder[i]!;
        switch (a.kind) {
          case 'tok': return matchTok(kidOf(r.nudToks[a.index]!), false) || (r.nudTplHole !== undefined && ir.tpl !== null && r.nudToks[a.index] === ir.tpl.token && matchTemplate(r.nudTplHole) !== null);
          case 'bracket': return all(r.nudBrackets[a.index]!.steps, false);
          case 'seq': return all(r.nudSeqs[a.index]!, false);
          case 'capped': return all(r.nudCapped[a.index]!.steps, false);
          case 'prefix': { const p = pre.get(r)!.get(t.lid); if (p === undefined) return false; pushLeaf(TT_OPERATOR, pos); pos++; return prattBp(r, p.rbp) !== null; }
        }
      };
      const test = (x: CommitTest & { all?: true }): boolean => {
        const a = r.nudOrder[x.arm]!;
        switch (a.kind) {
          case 'tok': return !(x.first || x.all) || t.kid === kidOf(r.nudToks[a.index]!);
          case 'bracket': return !(x.first || x.all) || t.lid === lidOf(r.nudBrackets[a.index]!.first);
          case 'seq': return rdTest(r.nudSeqGuard[a.index]!, x, t);
          case 'capped': return minBp < r.nudCapped[a.index]!.capBp && rdTest(r.nudCappedGuard[a.index]!, x, t);
          case 'prefix': return pre.get(r)!.has(t.lid);
        }
      };
      const none = () => { capped = false; form = 0; tail = false; return null; };
      if (act === null) { candidatesRefused(`${r.name} NUD (no arm at this key)`, arms, runArm, save, -1, save); return none(); }
      if (act !== 'frame' && !act.unless.some(test)) {
        const i = act.arm, a = r.nudOrder[i]!;
        let res: Sp | null = null, end = save, f = 0, tl = false, cp = false;
        if (test(act)) {
          const ck = checkpoint();
          if (a.kind === 'tok') { pushLeaf(t.kid, pos); pos++; res = finish(rid, sb); }
          else if (a.kind === 'prefix') {
            const p = pre.get(r)!.get(t.lid)!;
            pushLeaf(TT_OPERATOR, pos); pos++;
            const operand = prattBp(r, p.rbp);
            if (operand !== null && p.requireTarget && form !== 0) { pos = save; scratch.length = sb; restore(ck); capped = false; return null; }
            if (operand !== null) { scratch.push(operand.h); res = finish(rid, sb); f = p.form; tl = true; }
          } else {
            const steps = a.kind === 'bracket' ? r.nudBrackets[a.index]!.steps : a.kind === 'seq' ? guardSteps(r.nudSeqGuard[a.index]!, r.nudSeqs[a.index]!) : guardSteps(r.nudCappedGuard[a.index]!, r.nudCapped[a.index]!.steps);
            if ((act.clean && !act.nullable ? elided(`${r.name} NUD (committed to ${i}, clean)`, () => all(steps, false)) : all(steps, false)) && (!act.nullable || pos > save)) {
              res = finish(rid, sb);
              tl = a.kind === 'bracket' ? r.nudBracketClosesTail[a.index]! : a.kind === 'seq' ? r.nudSeqClosesTail[a.index]! : false;
              f = a.kind === 'bracket' ? r.nudBracketForm[a.index]! : a.kind === 'seq' ? r.nudSeqForm[a.index]! : 0;
              cp = a.kind === 'capped' || capped && (a.kind === 'bracket' ? r.nudBracketCapsFromTail[a.index]! : a.kind === 'seq' && r.nudSeqCapsFromTail[a.index]!);
            }
          }
          if (res === null) { pos = save; scratch.length = sb; restore(ck); } else { end = pos; noteCommit(r.name, t, i, r.nudOrder.length); }
        }
        pos = save; capped = false;
        candidatesRefused(`${r.name} NUD (committed to ${i})`, arms.filter((j) => res === null || j !== i), runArm, end, res ? i : -1, save);
        pos = end;
        if (res === null) return none();
        capped = cp; form = f; tail = tl;
        return res;
      }
    }
    const reached = new Set<number>(), refused: number[] = [];
    for (const { i, keyed } of dispatchOrder(d, t)) {
      reached.add(i);
      const a = r.nudOrder[i]!;
      switch (a.kind) {
        case 'tok': {
          const k = r.nudToks[a.index]!;
          if (keyed || t.kid === kidOf(k)) ends.push([i, save + 1]);
          if ((keyed || t.kid === kidOf(k)) && beats(save + 1, i)) { pushLeaf(t.kid, pos); pos++; best = finish(rid, sb); won(i, 0, false, false); pos = save; }
          if (r.nudTplHole !== undefined && ir.tpl && k === ir.tpl.token && t.kid === KID_TPL_HEAD) {
            const n = matchTemplate(r.nudTplHole);
            if (n !== null) ends.push([i, pos]);
            if (n !== null && beats(pos, i)) { scratch.push(n.h); best = finish(rid, sb); won(i, 0, false, false); }
            else { scratch.length = sb; restore(ck); }
            pos = save;
          }
          break;
        }
        case 'bracket': {
          const b = r.nudBrackets[a.index]!;
          if (!keyed && t.lid !== lidOf(b.first)) break;
          seqArm(i, b.steps, r.nudBracketClosesTail[a.index]!, false, null, r.nudBracketCapsFromTail[a.index]!, r.nudBracketForm[a.index]!);
          break;
        }
        case 'seq': {
          const g = r.nudSeqGuard[a.index]!;
          if (!guardOk(g, t, keyed)) { refused.push(i); break; }
          seqArm(i, r.nudSeqs[a.index]!.slice(g?.skip ?? 0), r.nudSeqClosesTail[a.index]!, false, g, r.nudSeqCapsFromTail[a.index]!, r.nudSeqForm[a.index]!);
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
          if (operand !== null) ends.push([i, pos]);
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
    if (best !== null) note(bg, t);
    noteTies(`${r.name} NUD`, ends, bestPos, bi, save);
    candidatesRefused(`${r.name} NUD`, refused, (i) => all(armSteps(i), false), bestPos, bi, save);
    capped = bc; form = bf; tail = bt;
    pos = bestPos;
    return best;
  }

  // The tree in the CST's form (TS target `parse`): a node's rule and children, a leaf's type and span.
  function tree(h: number): Cst {
    if (h < 0) { const v = -h - 1, t = toks[Math.floor(v / 256)]!; const i = Math.floor(v / 256); return { tokenType: ar.ttNames[v % 256]!, offset: t.off, end: opEnd.get(i) ?? t.end }; }
    const nd = nodes[h]!;
    return { rule: ar.ruleNames[nd.rule]!, children: nd.kids.map(tree) };
  }
  // `entry`: the rule the run parses the whole input as (the grammar's entry by default).
  return function run(tokens: Tok[], text: string, entry: string = ir.entry): Outcome {
    toks = tokens; src = text;
    pos = 0; capped = false; form = 0; tail = false; suppressNext = 0; suppressCur = 0; ctx = 0;
    scratch.length = 0; nodes.length = 0; opEnd.clear(); checking = base; checked = 0; cleanChecked = 0; leavesChecked = 0; unsound = []; found = {};
    const root = parseRule(entry);
    const accept = root !== null && pos === toks.length;
    return { accept, tree: accept ? tree(root!.h) : null, checked, cleanChecked, leavesChecked, unsound, found };
  };
}

// The TS target's tree with what the engine does not model left out: node spans.
export function canon(c: any): Cst {
  return 'rule' in c ? { rule: c.rule, children: c.children.map(canon) } : { tokenType: c.tokenType, offset: c.offset, end: c.end };
}
