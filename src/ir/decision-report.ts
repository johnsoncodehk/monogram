// The BUILD-TIME DECISION REPORT of a grammar: a page that says how the generated parser decides
// every choice point of the grammar, and what a grammar author should act on.
// `node src/cli.ts <grammar.ts> --decisions` writes it as `<name>.decisions.md` next to the grammar;
// test/decision-report.ts writes the root grammars' pages (docs/decisions/<grammar>.md) with the
// same functions plus the ties OBSERVED on pinned inputs, and gates both against drift.
//
// A choice point is a rule's alternatives, a Pratt rule's NUD arms and its LED connectors, an
// inline choice, and each star / opt / sep. How each is decided is read off the portable plan
// (src/ir/parser-ir.ts ParserIR), the plan every target prints:
//   • by ONE token: a predictive switch, a committed choice (Commit: the token leaves one
//     candidate), a candidate or a repetition body guarded by its FIRST set;
//   • by TWO tokens: a candidate's SECOND set or its pairs (Guard.second, Guard.pairs);
//   • by ATTEMPT: an ordered choice tries its branches in order, a repetition without a guard tries
//     its body at every iteration;
//   • by LONGEST MATCH in a candidate frame: the keys at which the frame is still entered, and the
//     candidates it reaches there;
//   • and whether the site takes a MARK that a failure restores (speculation), and why: the body
//     can fail after it consumed (Step.clean, PrattRule.ledClean, CommitAct.clean).
// The STATIC findings are derived the same way, each with a witness and a suggested action:
//   • TIES decided by declaration order: two candidates of one longest-match list that can both
//     match exactly one token at a token both admit, so only their order decides there (the
//     witness is that token; test/decision-report.ts parses it as the rule with the ParserIR engine
//     and requires the engine to observe the tie);
//   • DEAD alternatives: a candidate that always matches exactly one token, at every token it admits
//     an earlier-declared candidate is certain to be tried and matches at least that token: it never
//     wins (`node test/decision-report.ts --dead` proves each on the corpora);
//   • alternatives NO TOKEN REACHES: a candidate the plan's dispatch and commit switch never try.
// Nothing here is written per rule: every line comes from the plan.
import {
  portableIR, buildLexIdPlan, literalKinds,
  type ParserIR, type Step, type Guard, type PrattRule, type Commit, type CommitAct, type CommitCase, type Dispatch, type TokenSet, type LeadTest,
} from './parser-ir.ts';
import type { Grammar } from '../grammar/types.ts';

// ── rendering ──
const code = (s: string) => '`' + s.replace(/`/g, 'ˋ').replace(/\|/g, '\\|') + '`';
const clip = (s: string, n = 56) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const keyText = (k: string, lit: boolean) => (lit ? code(k) : k === '' ? 'punctuation' : `<${k}>`);
const list = (xs: string[], n = 8) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
function setText(s: TokenSet, n = 4): string {
  const xs = [...s.lits.map((l) => `'${l}'`), ...s.toks];
  return xs.length <= n ? xs.join('|') : `${xs.slice(0, n).join('|')}|…${xs.length - n}`;
}
function show(ir: ParserIR, s: Step, d = 0): string {
  const sub = (ss: Step[]) => ss.map((x) => show(ir, x, d + 1)).join(' ');
  if (d > 3) return '…';
  switch (s.t) {
    case 'lit': return `'${s.value}'`;
    case 'tok': return s.name;
    case 'rule': return s.name;
    case 'ruleBp': return s.name;
    case 'star': return `many(${show(ir, s.step, d + 1)})`;
    case 'opt': return `opt(${sub(s.steps)})`;
    case 'sep': return `sep(${show(ir, s.elem, d + 1)}, '${s.delim}')`;
    case 'altlit': return `(${s.opts.map((o) => `'${o.value}'`).join('|')})`;
    case 'alt': return `alt(${s.branches.map(sub).join(' | ')})`;
    case 'look': return `${s.is ? '&' : '!'}(${sub(ir.lookaheads[s.id]!)})`;
    case 'ahead': case 'aheadCtx': return `${s.is ? '&' : '!'}{${setText(ir.tokenSets[s.set]!)}}`;
    case 'seq': return `(${sub(s.steps)})`;
    case 'sameLine': return 'sameLine';
    case 'when': return `when(${s.mask}:${s.val})`;
    case 'assignTarget': return `assignTarget(${s.ctx})`;
    case 'suppress': case 'ctx': return sub(s.steps);
  }
}

// ── the plan's facts, read per step ──
const zeroWidth = (s: Step) => s.t === 'ahead' || s.t === 'aheadCtx' || s.t === 'sameLine' || s.t === 'when' || s.t === 'assignTarget' || s.t === 'look';
const neverFails = (s: Step): boolean => s.t === 'star' || s.t === 'opt' || s.t === 'sep' || ((s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') && s.steps.every(neverFails));
// Why a body that is not clean can fail after it consumed: where it consumes first.
function dirtyAfter(ir: ParserIR, steps: Step[]): string {
  const j = steps.findIndex((x) => !zeroWidth(x));
  if (j < 0) return 'it can fail';
  const x = steps[j]!;
  if (steps.length === j + 1 && (x.t === 'rule' || x.t === 'ruleBp')) return `a call of ${x.name} can fail after its operand (an operator that requires an assignment target)`;
  if (steps.length === j + 1 && (x.t === 'seq' || x.t === 'suppress' || x.t === 'ctx')) return dirtyAfter(ir, x.steps);
  return `it can fail after ${code(clip(show(ir, x), 40))}`;
}

// ── a longest-match list: an rd rule's alternatives or a Pratt rule's NUD arms ──
export type Cand = { name: string; kind: 'alt' | 'tok' | 'bracket' | 'seq' | 'capped' | 'prefix'; guard: Guard; first: TokenSet | null; steps: Step[]; tok?: string };
export type LM = { rule: string; list: string; what: 'alternatives' | 'NUD arms'; cands: Cand[]; commit?: Commit; dispatch: Dispatch; predictive: boolean };
function listsOf(ir: ParserIR): LM[] {
  const out: LM[] = [];
  for (const r of ir.rules) {
    if (r.kind === 'rd') {
      if (r.alts.length < 2) continue;
      out.push({
        rule: r.name, list: r.name, what: 'alternatives', predictive: r.predictive, dispatch: r.altDispatch, ...(r.altCommit ? { commit: r.altCommit } : {}),
        cands: r.alts.map((a, i): Cand => { const g = r.altGuard[i]!; return { name: r.altNames[i]!, kind: 'alt', guard: g, first: g?.first ?? (r.predictive && r.altFirst[i] ? { lits: r.altFirst[i]!.lits, toks: r.altFirst[i]!.toks } : null), steps: a.slice(g?.skip ?? 0) }; }),
      });
    } else {
      const ops = [...new Set(r.prefix.map((p) => p.op))];
      out.push({
        rule: r.name, list: `${r.name} NUD`, what: 'NUD arms', predictive: false, dispatch: r.nudDispatch, ...(r.nudCommit ? { commit: r.nudCommit } : {}),
        cands: r.nudOrder.map((n, i): Cand => {
          const name = r.nudNames[i]!;
          switch (n.kind) {
            case 'tok': { const k = r.nudToks[n.index]!; return { name, kind: 'tok', guard: null, first: { lits: [], toks: [k] }, steps: [{ t: 'tok', name: k }], tok: k }; }
            case 'bracket': { const b = r.nudBrackets[n.index]!; return { name, kind: 'bracket', guard: null, first: { lits: [b.first], toks: [] }, steps: b.steps }; }
            case 'seq': { const g = r.nudSeqGuard[n.index]!; return { name, kind: 'seq', guard: g, first: g?.first ?? null, steps: r.nudSeqs[n.index]!.slice(g?.skip ?? 0) }; }
            case 'capped': { const g = r.nudCappedGuard[n.index]!; return { name, kind: 'capped', guard: g, first: g?.first ?? null, steps: r.nudCapped[n.index]!.steps.slice(g?.skip ?? 0) }; }
            case 'prefix': return { name, kind: 'prefix', guard: null, first: { lits: ops, toks: [] }, steps: [] };
          }
        }),
      });
    }
  }
  return out;
}
const dispatchArms = (d: Dispatch): Set<number> => new Set(d.sections.flatMap((s) => (s.by === 'rest' ? s.arms : s.groups.flatMap((g) => g.arms))));
const commitActs = (c: Commit | undefined): CommitAct[] => (c ? [...c.lid, ...c.kid].flatMap((x) => (x.act !== null && x.act !== 'frame' ? [x.act] : [])) : []);
// A test only the token after the first decides: a SECOND set, or a pair at one of the case's keys.
const twoToken = (l: LM, t: { arm: number; pairs?: number[] }) => (l.cands[t.arm]!.guard?.second ?? null) !== null || (t.pairs?.length ?? 0) > 0;

// One token of the stream, as the plan's tests see it: its literal (null: none any test reads) and its kind.
export type Cls = { lit: string | null; kind: string };
function classesOf(ir: ParserIR): { all: Cls[]; kindsOf: (l: string) => ReadonlySet<string> } {
  const kindsOf = literalKinds(ir);
  const kinds = [...ir.tokens.filter((t) => !t.skip).map((t) => t.name), ...(ir.newlineCfg ? [ir.newlineCfg.token] : []), ...(ir.tpl ? ['$templateHead', '$templateMiddle', '$templateTail'] : []), ''];
  const all: Cls[] = [];
  for (const l of buildLexIdPlan(ir).lids.slice(1)) for (const k of kindsOf(l)) all.push({ lit: l, kind: k });
  for (const k of kinds) if (k !== '') all.push({ lit: null, kind: k });
  return { all, kindsOf };
}
const inSet = (s: TokenSet, c: Cls) => (c.lit !== null && s.lits.includes(c.lit)) || s.toks.includes(c.kind);
function admission(ir: ParserIR) {
  const leadAt = (l: LeadTest, c: Cls): 'yes' | 'no' | 'maybe' => {
    const x = inSet(ir.tokenSets[l.set]!, c);
    if (!x && l.ctx && c.lit !== null && ir.ctxWords.includes(c.lit)) return 'maybe';
    return x === l.is ? 'yes' : 'no';
  };
  const lead = (x: Cand, c: Cls) => { const r = (x.guard?.lead ?? []).map((l) => leadAt(l, c)); return r.includes('no') ? 'no' : r.includes('maybe') ? 'maybe' : 'yes'; };
  const firstHolds = (x: Cand, c: Cls) => x.first === null || inSet(x.first, c);
  const pairAt = (x: Cand, c: Cls) => (x.guard?.pairs ?? []).some((p) => inSet(p.when, c));
  return {
    viable: (x: Cand, c: Cls) => firstHolds(x, c) && lead(x, c) !== 'no',
    certain: (x: Cand, c: Cls) => firstHolds(x, c) && lead(x, c) === 'yes' && (x.guard?.second ?? null) === null && !pairAt(x, c) && x.kind !== 'capped' && x.kind !== 'prefix',
  };
}
// The one token a step matches by itself (a literal, a kind, a literal alternation); null: not one token.
function oneTokenSet(ir: ParserIR, s: Step): TokenSet | null {
  if (s.t === 'lit') return ir.gtComps.includes(s.value) ? null : { lits: [s.value], toks: [] };
  if (s.t === 'tok') return s.hole === undefined ? { lits: [], toks: [s.name] } : null;
  if (s.t === 'altlit') return s.opts.some((o) => ir.gtComps.includes(o.value)) ? null : { lits: s.opts.map((o) => o.value), toks: [] };
  return null;
}
// Whether a candidate can match exactly one token (its tokens: the set), and whether it always does.
function oneToken(ir: ParserIR, x: Cand): { set: TokenSet; always: boolean } | null {
  if (x.kind === 'prefix' || x.kind === 'capped' || (x.guard?.second ?? null) !== null) return null;
  if (x.kind === 'tok') return ir.tpl !== null && x.tok === ir.tpl.token ? null : { set: { lits: [], toks: [x.tok!] }, always: true };
  const [h, ...rest] = x.steps;
  const set = h === undefined ? null : oneTokenSet(ir, h);
  if (set === null || !rest.every(neverFails)) return null;
  return { set, always: rest.length === 0 };
}

// A tie: `witness` is the static one (a literal both admit); `observed` is filled by a caller that
// ran the parser over inputs (test/decision-report.ts), never by this module.
export type Tie = { list: string; rule: string; winner: number; loser: number; wName: string; lName: string; tokens: Cls[]; witness?: string; observed?: { n: number; at: string } };
export type Dead = { list: string; rule: string; arm: number; name: string; by: number[]; tokens: Cls[] };
export type DecisionFindings = { lists: LM[]; ties: Tie[]; dead: Dead[]; unreached: Array<{ list: string; arm: number; name: string }> };
export function analyzeDecisions(ir: ParserIR): DecisionFindings {
  const lists = listsOf(ir);
  const { all } = classesOf(ir);
  const A = admission(ir);
  const ties: Tie[] = [], dead: Dead[] = [], unreached: DecisionFindings['unreached'] = [];
  for (const l of lists) {
    const one = l.cands.map((x) => oneToken(ir, x));
    // ties at one token
    for (let i = 0; i < l.cands.length; i++) {
      const oi = one[i];
      if (!oi) continue;
      for (let j = 0; j < i; j++) {
        const oj = one[j];
        if (!oj) continue;
        const at = all.filter((c) => inSet(oi.set, c) && inSet(oj.set, c) && A.viable(l.cands[i]!, c) && A.viable(l.cands[j]!, c));
        if (at.length === 0) continue;
        const lit = at.find((c) => c.lit !== null);
        ties.push({ list: l.list, rule: l.rule, winner: j, loser: i, wName: l.cands[j]!.name, lName: l.cands[i]!.name, tokens: at, ...(lit ? { witness: lit.lit! } : {}) });
      }
    }
    // dead: always one token, and every token it admits an earlier candidate surely takes, matching at least it
    const takes = (j: number, c: Cls): boolean => {
      const x = l.cands[j]!;
      if (!A.certain(x, c)) return false;
      if (x.kind === 'tok') return c.kind === x.tok;
      const [h, ...rest] = x.steps;
      const s = h === undefined ? null : oneTokenSet(ir, h);
      return s !== null && inSet(s, c) && rest.every(neverFails);
    };
    for (let i = 0; i < l.cands.length; i++) {
      const oi = one[i];
      if (!oi?.always) continue;
      const at = all.filter((c) => inSet(oi.set, c) && A.viable(l.cands[i]!, c));
      if (at.length === 0) continue;
      const by = new Set<number>();
      if (at.every((c) => { const j = l.cands.findIndex((_, k) => k < i && takes(k, c)); if (j < 0) return false; by.add(j); return true; })) {
        dead.push({ list: l.list, rule: l.rule, arm: i, name: l.cands[i]!.name, by: [...by], tokens: at });
      }
    }
    // never reached: neither the frame's dispatch nor any commit tries it
    if (!l.predictive) {
      const reached = dispatchArms(l.dispatch);
      for (const a of commitActs(l.commit)) { reached.add(a.arm); for (const u of a.unless) reached.add(u.arm); }
      l.cands.forEach((x, i) => { if (!reached.has(i)) unreached.push({ list: l.list, arm: i, name: x.name }); });
    }
  }
  return { lists, ties, dead, unreached };
}

// ── what the author can do about a finding: derived from the finding, never written per rule ──
const armsText = (l: LM, arms: number[]) => list(arms.map((j) => code(l.cands[j]!.name)), 3);
export function deadAction(l: LM, d: Dead): string {
  const by = armsText(l, d.by);
  return `remove the arm, or declare it before ${by} / guard ${by}: ${by}, declared before it, ${d.by.length > 1 ? 'take' : 'takes'} every input it could match`;
}
export function tieAction(t: Tie): string {
  const on = t.witness !== undefined ? ` on ${code(t.witness)}` : t.tokens.length ? ` on ${tokensText(t.tokens)[0]}` : '';
  return `reorder, or guard ${code(t.wName)}: the tie of ${t.wName} and ${t.lName}${on} is resolved only by declaration order (${t.wName} wins)`;
}
export function unreachedAction(u: { name: string }): string {
  return `remove the arm, or reorder / guard the arms its first tokens are committed to: no token reaches ${code(u.name)}`;
}

// ── choice points: how each is decided ──
type Mode = 'one' | 'two' | 'attempt' | 'frame';
type Site = { kind: string; where: string; text: string; mode: Mode; mark: boolean; why: string };
const MODE_TEXT: Record<Mode, string> = { one: 'one token', two: 'two tokens', attempt: 'by attempt', frame: 'longest match' };
function listSite(ir: ParserIR, l: LM, kinds: string[]): Site & { lines: string[] } {
  const lines: string[] = [];
  const nm = (i: number) => `${l.cands[i]!.name} (#${i})`;
  if (l.predictive) return { kind: 'rule alternatives', where: l.list, text: `${l.cands.length} alternatives`, mode: 'one', mark: false, why: '', lines: [`one token: a switch on each alternative's FIRST set (no two share a token)`] };
  let two = false;
  const frameKeys: string[] = [];
  const marks: string[] = [];
  if (l.commit) {
    const caseLine = (c: CommitCase, lit: boolean) => {
      const keys = list(c.keys.map((k) => keyText(k, lit)));
      if (c.act === null) return `${keys}: no candidate, the list fails`;
      if (c.act === 'frame') { frameKeys.push(...c.keys.map((k) => keyText(k, lit))); return null; }
      const a = c.act;
      const t2 = twoToken(l, a) || a.unless.some((u) => twoToken(l, u));
      if (t2) two = true;
      if (!a.clean) marks.push(nm(a.arm));
      const unless = a.unless.length ? `, unless ${list(a.unless.map((u) => nm(u.arm)), 4)} ${a.unless.length > 1 ? 'admit' : 'admits'} the token (then the frame)` : '';
      return `${keys}: ${t2 ? 'two tokens' : 'one token'}: committed to ${nm(a.arm)}${unless}${a.clean ? '' : ' (takes a mark: ' + (l.cands[a.arm]!.kind === 'prefix' ? 'its operand can fail after the operator' : dirtyAfter(ir, l.cands[a.arm]!.steps)) + ')'}`;
    };
    for (const c of l.commit.lid) { const s = caseLine(c, true); if (s) lines.push(s); }
    for (const c of l.commit.kid) { const s = caseLine(c, false); if (s) lines.push(s); }
  }
  const inFrame = [...dispatchArms(l.dispatch)].sort((a, b) => a - b);
  const pairs = l.cands.flatMap((x, i) => (x.guard?.pairs ?? []).map((p) => `${nm(i)} at ${list(p.when.lits.map((k) => code(k)), 4)} only before ${setText(p.second, 6)}`));
  if (pairs.length) { two = true; lines.push(`two tokens (pairs): ${pairs.join('; ')}`); }
  const seconds = l.cands.flatMap((x, i) => (x.guard?.second ? [`${nm(i)} only before ${setText(x.guard.second, 6)}`] : []));
  if (seconds.length) { two = true; lines.push(`two tokens (SECOND): ${seconds.join('; ')}`); }
  if (inFrame.length) {
    const named = new Set(l.commit?.kid.flatMap((c) => c.keys) ?? []);
    const unnamed = kinds.some((k) => !named.has(k));
    const hasUnless = commitActs(l.commit).some((a) => a.unless.length > 0);
    const where = !l.commit ? 'at every token' : `at ${[...(frameKeys.length ? [list(frameKeys)] : []), ...(hasUnless ? ['the keys above where an `unless` candidate admits the token'] : []), ...(unnamed ? ['every token of a kind no case names'] : [])].join(', ') || 'no token'}`;
    lines.push(`longest match: a candidate frame (a mark per new best) ${where}, over ${list(inFrame.map(nm), 6)}`);
  }
  const mode: Mode = inFrame.length ? 'frame' : two ? 'two' : 'one';
  return { kind: l.what === 'alternatives' ? 'rule alternatives' : 'NUD arms', where: l.list, text: `${l.cands.length} ${l.what}`, mode, mark: inFrame.length > 0 || marks.length > 0, why: inFrame.length ? 'the candidate frame' : marks.length ? `committed ${list(marks, 3)} can fail after consuming` : '', lines };
}
function ledSite(ir: ParserIR, r: PrattRule): (Site & { lines: string[] }) | null {
  if (r.leds.length === 0) return null;
  const by = new Map<string, number[]>();
  r.leds.forEach((b, i) => { const a = by.get(b.first); if (a) a.push(i); else by.set(b.first, [i]); });
  const bin = new Set(r.binary.map((b) => b.op)), post = new Set(r.postfix.map((p) => p.op));
  const lines: string[] = [];
  let ordered = false;
  const marks: string[] = [];
  for (const [conn, arms] of by) {
    const op = bin.has(conn) ? ' then the binary operator' : post.has(conn) ? ' then the postfix operator' : '';
    const many = arms.length > 1 || op !== '';
    if (many) ordered = true;
    const dirty = arms.filter((i) => !r.ledClean[i]);
    for (const i of dirty) marks.push(`${r.ledNames[i]} (${code(conn)})`);
    lines.push(`${code(conn)}: ${many ? `by attempt, in order: ${arms.map((i) => r.ledNames[i]).join(', ')}${op}` : `one token: ${r.ledNames[arms[0]!]}`}${dirty.length ? ` (takes a builder checkpoint: ${dirty.map((i) => `${r.ledNames[i]}: ${dirtyAfter(ir, r.leds[i]!.steps.slice(1))}`).join('; ')})` : ''}`);
  }
  return { kind: 'LED connectors', where: `${r.name} LED`, text: `${by.size} connectors, ${r.binary.length} binary operators`, mode: ordered ? 'attempt' : 'one', mark: marks.length > 0, why: marks.length ? `${list(marks, 4)}` : '', lines };
}
// Every inline choice and repetition of a rule's step lists, with where it stands. `rf` is the same
// rule in the Go / TS plan (no callee-first guards), to mark a guard only Rust takes.
function stepSites(ir: ParserIR, r: ParserIR['rules'][number], rf: ParserIR['rules'][number]): Site[] {
  const out: Site[] = [];
  const visit = (s: Step, sf: Step, where: string) => {
    const at = where;
    if (s.t === 'alt' && sf.t === 'alt') {
      const dirty = s.branches.flatMap((_b, i) => (s.clean?.[i] ? [] : [i]));
      out.push({ kind: 'inline choice', where: at, text: show(ir, s), mode: s.predictive ? 'one' : 'attempt', mark: dirty.length > 0, why: dirty.map((i) => `branch ${i}: ${dirtyAfter(ir, s.branches[i]!)}`).join('; ') });
      s.branches.forEach((b, i) => b.forEach((x, k) => visit(x, (sf.branches[i] ?? [])[k] ?? x, at)));
    } else if ((s.t === 'star' || s.t === 'opt' || s.t === 'sep') && s.t === sf.t) {
      const body = s.t === 'star' ? [s.step] : s.t === 'sep' ? [s.elem] : s.steps;
      const guarded = s.guard !== undefined, rustOnly = guarded && (sf as { guard?: number }).guard === undefined;
      out.push({ kind: s.t, where: at, text: show(ir, s), mode: guarded ? 'one' : 'attempt', mark: !s.clean, why: (s.clean ? '' : dirtyAfter(ir, body)) + (rustOnly ? ' [guard: Rust only]' : '') });
      const bf = sf.t === 'star' ? [sf.step] : sf.t === 'sep' ? [sf.elem] : (sf as { steps: Step[] }).steps;
      body.forEach((x, k) => visit(x, bf[k] ?? x, at));
    } else if (s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') {
      const ff = (sf as { steps?: Step[] }).steps ?? s.steps;
      s.steps.forEach((x, k) => visit(x, ff[k] ?? x, at));
    }
  };
  const bodies = (x: typeof r): Array<[string, Step[]]> => (x.kind === 'rd'
    ? x.alts.map((a, i) => [x.alts.length > 1 ? `${x.name} / ${x.altNames[i]}` : x.name, a] as [string, Step[]])
    : [...x.nudBrackets.map((b, i) => [`${x.name} NUD / ${x.nudNames[x.nudOrder.findIndex((n) => n.kind === 'bracket' && n.index === i)]}`, b.steps] as [string, Step[]]),
      ...x.nudSeqs.map((b, i) => [`${x.name} NUD / ${x.nudNames[x.nudOrder.findIndex((n) => n.kind === 'seq' && n.index === i)]}`, b] as [string, Step[]]),
      ...x.nudCapped.map((b, i) => [`${x.name} NUD / ${x.nudNames[x.nudOrder.findIndex((n) => n.kind === 'capped' && n.index === i)]}`, b.steps] as [string, Step[]]),
      ...x.leds.map((b, i) => [`${x.name} LED / ${x.ledNames[i]}`, b.steps] as [string, Step[]])]);
  const fb = bodies(rf);
  bodies(r).forEach(([where, steps], k) => steps.forEach((s, j) => visit(s, fb[k]?.[1][j] ?? s, where)));
  return out;
}
const tokensText = (cs: Cls[]) => [...new Set(cs.map((c) => (c.lit !== null ? code(c.lit) : keyText(c.kind, false))))];

// ── the page ──
export type PageOptions = {
  // The command that writes this page, quoted in its header.
  command: string;
  // How the page's ties were observed on inputs (the ties' `observed` fields are filled), or null:
  // a static page, which says how to observe them.
  observed: string | null;
};
// `ir` is the grammar's plan; `irGoTs` the plan Go and TS print (no callee-first guards).
export function renderDecisions(name: string, ir: ParserIR, irGoTs: ParserIR, rep: DecisionFindings, opts: PageOptions): string {
  const ties = [...rep.ties].sort((a, b) => (a.list < b.list ? -1 : a.list > b.list ? 1 : a.winner - b.winner || a.loser - b.loser));
  const lm = (list: string) => rep.lists.find((x) => x.list === list)!;
  const sites: Array<Site & { lines?: string[] }> = [];
  const byRule = new Map<string, Array<Site & { lines?: string[] }>>();
  const add = (rule: string, s: Site & { lines?: string[] }) => { sites.push(s); const a = byRule.get(rule); if (a) a.push(s); else byRule.set(rule, [s]); };
  const kinds = [...new Set(classesOf(ir).all.map((c) => c.kind))];
  for (const l of rep.lists) add(l.rule, listSite(ir, l, kinds));
  ir.rules.forEach((r, k) => {
    if (r.kind === 'pratt') { const s = ledSite(ir, r); if (s) add(r.name, s); }
    for (const s of stepSites(ir, r, irGoTs.rules[k]!)) add(r.name, s);
  });
  const L: string[] = [];
  L.push(`# How the ${name} parser decides`);
  L.push('');
  L.push(`<!-- generated by \`${opts.command}\` from the portable plan (src/ir/parser-ir.ts) of \`${name}.ts\`; do not edit by hand. -->`);
  L.push('');
  L.push(`Every choice point of the grammar and how the generated parser (the portable plan every target prints) decides it: by one token, by two tokens, by attempt (an ordered choice tries its branches in order; a repetition without a FIRST guard tries its body), or by longest match in a candidate frame; and whether it takes a mark that a failure restores. Then the findings a grammar author should act on, each with its witness and a suggested action. How it is derived: src/ir/decision-report.ts.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| choice point | sites | one token | two tokens | by attempt | longest match | take a mark |');
  L.push('|:--|--:|--:|--:|--:|--:|--:|');
  for (const kind of ['rule alternatives', 'NUD arms', 'LED connectors', 'inline choice', 'star', 'opt', 'sep']) {
    const ss = sites.filter((s) => s.kind === kind);
    if (ss.length === 0) continue;
    const n = (m: Mode) => ss.filter((s) => s.mode === m).length;
    L.push(`| ${kind} | ${ss.length} | ${n('one')} | ${n('two')} | ${n('attempt')} | ${n('frame')} | ${ss.filter((s) => s.mark).length} |`);
  }
  L.push('');
  const deadSet = new Set(rep.dead.map((d) => `${d.list}|${d.arm}`));
  const tiesLive = ties.filter((t) => !deadSet.has(`${t.list}|${t.loser}`));
  L.push('| finding | count |');
  L.push('|:--|--:|');
  L.push(`| dead alternatives (never win) | ${rep.dead.length} |`);
  L.push(`| ties decided by declaration order (one token: ${ties.filter((t) => t.tokens.length).length}${opts.observed !== null ? `; observed on ${opts.observed}: ${ties.filter((t) => t.observed).length}` : ''}) | ${ties.length} |`);
  L.push(`| alternatives no token reaches | ${rep.unreached.length} |`);
  L.push('');
  L.push('## Findings');
  L.push('');
  L.push('### Dead alternatives');
  L.push('');
  if (rep.dead.length === 0) L.push('None.');
  else {
    L.push('It always matches exactly one token, and at every token it admits a candidate declared before it is surely tried and matches at least that token: the earlier one wins the tie, so this one never wins. For the root grammars `node test/decision-report.ts --dead` removes each from the grammar and requires that no tree on the corpora changes.');
    L.push('');
    L.push('| list | dead alternative | taken by | at | witness | action |');
    L.push('|:--|:--|:--|:--|:--|:--|');
    for (const d of rep.dead) {
      const t = ties.find((x) => x.list === d.list && x.loser === d.arm && x.witness !== undefined);
      const l = lm(d.list);
      L.push(`| ${d.list} | ${d.name} (#${d.arm}) | ${d.by.map((j) => `${l.cands[j]!.name} (#${j})`).join(', ')} | ${list(tokensText(d.tokens), 4)} | ${t ? `${code(t.witness!)} as ${d.rule}` : ''} | ${deadAction(l, d)} |`);
    }
  }
  L.push('');
  L.push('### Ties decided by declaration order');
  L.push('');
  if (tiesLive.length === 0) L.push('None besides the dead alternatives.');
  else {
    if (opts.observed !== null) {
      L.push(`Two candidates of one list match the same input to the same end; the one declared first wins. Where the later one is meant to win there, the grammar must say so (reorder, or refuse the token in the earlier one). "One token": both can match exactly one token at these tokens (the witness is that token parsed as the rule, where the engine observes the tie). "Observed": a frame on ${opts.observed} where they tied (how often, and the first place).`);
      L.push('');
      L.push('| list | wins (declared first) | loses | one token | observed | witness | action |');
      L.push('|:--|:--|:--|:--|--:|:--|:--|');
      for (const t of tiesLive) L.push(`| ${t.list} | ${t.wName} (#${t.winner}) | ${t.lName} (#${t.loser}) | ${t.tokens.length ? list(tokensText(t.tokens), 4) : ''} | ${t.observed?.n ?? ''} | ${t.observed ? t.observed.at : t.witness !== undefined ? `${code(t.witness)} as ${t.rule}` : ''} | ${tieAction(t)} |`);
    } else {
      L.push('Two candidates of one list can both match exactly one token at these tokens, to the same end; the one declared first wins there. Where the later one is meant to win, the grammar must say so (reorder, or refuse the token in the earlier one). The witness is that token parsed as the rule. This page has the static ties only: the ties a real input meets (how often, and where) come from running the parser over inputs: `node test/decision-report.ts --observe <grammar.ts> <input files>`.');
      L.push('');
      L.push('| list | wins (declared first) | loses | one token | witness | action |');
      L.push('|:--|:--|:--|:--|:--|:--|');
      for (const t of tiesLive) L.push(`| ${t.list} | ${t.wName} (#${t.winner}) | ${t.lName} (#${t.loser}) | ${list(tokensText(t.tokens), 4)} | ${t.witness !== undefined ? `${code(t.witness)} as ${t.rule}` : ''} | ${tieAction(t)} |`);
    }
  }
  L.push('');
  L.push('### Alternatives no token reaches');
  L.push('');
  if (rep.unreached.length === 0) L.push('None.');
  else for (const u of rep.unreached) L.push(`- ${u.list}: ${u.name} (#${u.arm}): neither the dispatch nor the commit switch tries it at any token. Action: ${unreachedAction(u)}.`);
  L.push('');
  L.push('## Choice points');
  L.push('');
  L.push('Per rule: its candidate lists (every key and what decides it), then the inline choices and repetitions that are not decided by one token without a mark (the others are counted).');
  for (const r of ir.rules) {
    const ss = byRule.get(r.name) ?? [];
    L.push('');
    L.push(`### ${r.name}`);
    L.push('');
    for (const s of ss.filter((x) => x.lines)) {
      L.push(`- ${s.where} (${s.text}):`);
      for (const x of s.lines!) L.push(`  - ${x}`);
    }
    const plain = ss.filter((x) => !x.lines && x.mode === 'one' && !x.mark);
    const rest = ss.filter((x) => !x.lines && !(x.mode === 'one' && !x.mark));
    if (plain.length) L.push(`- one token, no mark: ${['inline choice', 'star', 'opt', 'sep'].map((k) => [k, plain.filter((x) => x.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'inline choice' ? (n > 1 ? 'inline choices' : 'inline choice') : k}`).join(', ')}`);
    for (const s of rest) L.push(`- ${s.where}: ${code(clip(s.text))}: ${MODE_TEXT[s.mode]}${s.mark ? `; takes a mark: ${s.why}` : s.why ? `;${s.why}` : ''}`);
  }
  L.push('');
  return L.join('\n');
}

// The static page of one grammar, as `node src/cli.ts <grammar.ts> --decisions` writes it.
export function decisionReport(grammar: Grammar, name: string): { text: string; findings: DecisionFindings } {
  const ir = portableIR(grammar);
  const findings = analyzeDecisions(ir);
  const text = renderDecisions(name, ir, portableIR(grammar, { calleeFirstGuards: false }), findings, { command: 'node src/cli.ts <grammar.ts> --decisions', observed: null });
  return { text, findings };
}
