// The Go Target for emit-portable. Renders the same language-agnostic ParserIR as tsTarget
// into a self-contained Go program (Go stdlib only — the lexer is regex-free, so it compiles
// with no module dependencies). Its CST JSON is checked byte-for-byte against the interpreter,
// so `emitParser(grammar, goTarget)` is a real, verified Go parser derived from the
// same grammar definition.
//
// ARENA allocation (to minimise GC pressure, as tsgo does): nodes live in a flat `nodes []Node`,
// their children in a flat `kids []int32`, and in-progress children accumulate on a `scratch`
// stack. A node is an int32 index, never a heap pointer. Backtracking truncates the three
// slices to saved lengths; the slices keep their capacity across parses (reset to len 0), so a
// warmed parser allocates ~nothing per parse.
import { type ParserIR, type RdRule, type PrattRule, type NudRef, type Step, type Bracket, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type Guard, type Dispatch, type LexFirstBytes, type LexIdPlan, type ArenaIdPlan, type ReusePlan, type ReusePlanA, type ReusePlanB } from './emit-portable.ts';
import { blockBody, elementBraceSteps, elementTokens, regionKids, portableIR, sepDelimLid, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, buildLidTables, lidWordByte, buildArenaIdPlan, lidOf, lidDeltaTable, ctxWordLids, kidOf, lidFlagTable, kidFlagTable, ttIdOf, ruleIdOf, TT_SKIP_PUNCT, isFirstGuardable, groupByPreserveOrder, tplHoleRules, tokenSetBits, prattOpTables, stepExpr as walkExpr, stepStmts as walkStmts, ruleShell, prattShell, entryShell, dispatchWalk, gtCompLit, type PortableFacts, type StepLowering, type DispatchLowering, type PrattLowering, type CommitLowering } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { defineTarget, type SharedAlgorithms } from './define-target.ts';
import { ATOM, COMPARISON, findAnyName, stopBytes, isNum, isOpt, isRec, isRecList, recName, type BinOp, type Lowering, type MetaInt, type MkMeta, type R, type TokInt, type Ty } from './algo-ir.ts';
import { uniIdentPlan, uniLookup } from './uni-ident.ts';
import { type TextUnits, firstUnit, unitLen } from './text-units.ts';

const J = (v: unknown) => JSON.stringify(v);
// Go strings are indexed by UTF-8 byte: every offset and length printed here is in bytes.
const UNITS: TextUnits = 'utf8';
const tlen = (text: string): number => unitLen(text, UNITS);

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.Lid == ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.Kid == ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);
// A longest-match candidate's Guard (emit-portable.ts) over the buffered token t, for the engine
// (w '') or the builder walker (w 'W').
// keyed: the candidate is reached through its Dispatch key, which already tested the first token.
const guardCond = (g: Guard, t: string, w: '' | 'W', keyed: boolean): string[] => {
  if (g === null) return [];
  const parts = keyed || g.first === null ? [] : [`inTokenSet(${g.first.id}, ${t})`];
  if (g.second !== null) parts.push(`p.secondIn(${g.second.id})`);
  for (const l of g.lead) {   // the guard's lead tests (emit-portable.ts LeadTest) on t
    const inS = l.ctx ? `(inTokenSet(${l.set}, ${t}) || (p.ctx != 0 && inCtxWords(p.ctx, ${t})))` : `inTokenSet(${l.set}, ${t})`;
    parts.push(l.is ? inS : `!${inS}`);
  }
  return parts;
};
// `if <conds> <body>` as one statement line (just the body when there is no condition).
const ifGo = (conds: string[], body: string) => (conds.length ? `\tif ${conds.join(' && ')} ${body}` : `\t${body}`);
// A candidate list's Dispatch over the buffered token t: arm(i, keyed) is candidate i's statement.
// nilable: t may be nil (no token left), which no key matches.
const dispatchGoL = (t: string): DispatchLowering => ({
  sw: (by, cases) => `\tswitch ${t}.${by === 'lid' ? 'Lid' : 'Kid'} {\n${cases.map((c) => `\tcase ${c.key}:\n${c.arms.join('\n')}`).join('\n')}\n\t}`,
  nil: (sw) => `\tif ${t} != nil {\n${sw}\n\t}`,
});
const dispatchGo = (d: Dispatch, t: string, ids: LexIdPlan, arm: (i: number, keyed: boolean) => string, nilable = false): string =>
  dispatchWalk(d, ids, arm, dispatchGoL(t), nilable);
// A Commit's switch (emit-portable.ts commitWalk) over the buffered token t.
const commitSwGo = (t: string): CommitLowering => ({
  sw: (by, cases, dflt) => `\tswitch ${t}.${by === 'lid' ? 'Lid' : 'Kid'} {\n${cases.map((c) => `\tcase ${c.keys.join(', ')}:${c.stmt ? `\n${c.stmt}` : ''}`).join('\n')}${dflt ? `\n\tdefault:\n${dflt}` : ''}\n\t}`,
  ifAll: ifGo,
  notAll: (conds) => `!(${conds.join(' && ')})`,
  pickDecl: '\t_c := 0',
  pick: (n) => `{ _c = ${n} }`,
  picked: (cases) => `\tswitch _c {\n${cases.map((c) => `\tcase ${c.n}:\n\t${c.stmt}`).join('\n')}\n\t}`,
});
// A committed candidate's body in a building form: `cond` from here; matched, `ret` of its node
// (`fin` over the scratch start and the start position), else undone (`undo`: the checkpoint taken,
// the undo to it, and where it keeps the scratch start and the position; none when the candidate
// fails clean, so none is taken). The native engine's is its mark / reset (both within Go's inline
// budget); the builder engine's mark is not inlined around the builder's Checkpoint, so its
// checkpoint and undo stay printed in place (measured: +0.27% builder instructions with mark()).
type GoUndo = { take: string; undo: string; sb: string; save: string };
const UNDO_GO: GoUndo = { take: 'm := p.mark()', undo: 'p.reset(m)', sb: 'm.sb', save: 'm.pos' };
const undoGoWc = (recv: string): GoUndo => ({ take: `save := p.pos; sb := len(p.scratch); ${arenaCkpt()}`, undo: `p.back(save); ${lostGoW(recv)}`, sb: 'sb', save: 'save' });
// The direct engine's node over a commit's extent (finish is not inlined: a helper around it
// would add a call, measured by -gcflags=-m: over Go's inlining budget).
const finGo = (rid: number) => (sb: string, save: string) => `p.finish(${rid}, ${sb}, p.offAt(${save}), ${save})`;
const commitBodyGo = (cond: string, undo: GoUndo | null, nullable: boolean, fin: (sb: string, save: string) => string, ret: (n: string) => string) => (undo !== null
  ? `{ ${undo.take}; if ${cond}${nullable ? ` && p.pos > ${undo.save}` : ''} { ${ret(fin(undo.sb, undo.save))} }; ${undo.undo} }`
  : `{ save := p.pos; sb := len(p.scratch); if ${cond} { ${ret(fin('sb', 'save'))} } }`);
// A committed candidate's statement: `body` when conds hold, then `fail` (unless body always returns).
// With no condition the body's block is the statement's own (blockBody).
const commitGo = (conds: string[], body: string, fail: string, returns = false) =>
  `{ ${conds.length ? `if ${conds.join(' && ')} ${body.startsWith('{') ? body : `{ ${body} }`}` : blockBody(body) ?? body}${conds.length || !returns ? `; ${fail}` : ''} }`;
// Whether the candidate i that just ended at pos beats the best so far: it ends past it, or — a
// Dispatch `ranked` candidate — ties it and was declared earlier. `bi` (the best one's index) is
// kept only in a list that has ranked candidates.
const beatsGo = (d: Dispatch, pos: string, i: number) => d.ranked.includes(i) ? `(${pos} > bestPos || ${pos} == bestPos && ${i} < bi)` : `${pos} > bestPos`;
const markGo = (d: Dispatch, i: number) => (d.ranked.length ? ` bi = ${i};` : '');
const biGo = (d: Dispatch) => (d.ranked.length ? '; bi := -1' : '');
// ── The two frames of a construct that may have to undo what it tried ──
// Every one is printed by one of these, so what a frame costs in the output is decided here. The
// checkpoint (position, scratch length, arena lengths) and the undo back to it, in the native
// engine; the builder engine's checkpoint is the builder's (ckptGoW / undoGoW).
const ckptGo = 'm := p.mark();';
const undoGo = 'p.reset(m)';
const ckptGoW = (_recv: string) => 'm := p.mark()';
const undoGoW = (_recv: string) => 'p.back(m.pos); p.scratch = p.scratch[:m.sb]; p.b.Restore(m.nb, m.kb)';
// BRANCH frame: one branch of an ordered choice (`alt`): it returns true from the choice when the
// branch matched, and undoes it when it did not.
const branchGo = (cond: string) => `{ ${ckptGo} if ${cond} { return true }; ${undoGo} }`;
const branchGoW = (cond: string, recv: string) => `{ ${ckptGoW(recv)}; if ${cond} { return true }; ${undoGoW(recv)} }`;
// CANDIDATE frame: one candidate of a longest-match list tried from `save`: when it matched and
// beats the best so far it becomes the best (`win` records it and moves the arena checkpoint past
// its node), else `lost` drops what it built; either way the position goes back to `save`.
const lostGo = 'p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]';
const lostGoW = (_recv: string) => `p.scratch = p.scratch[:sb]; ${arenaRestore()}`;
const candGo = (d: Dispatch, i: number, cond: string, win: string, lost: string) =>
  `{ if ${cond} && ${beatsGo(d, 'p.pos', i)} { ${win} } else { ${lost} }; p.back(save) }`;

// The Go spelling of an rd rule's shell (emit-portable.ts, ruleShell), common to its three forms.
// PREDICTIVE arms are joined on one line: Go's semicolon insertion after a line-final `}` would
// break `}` / `else if` across lines.
const goRuleBase = (r: RdRule, ids: LexIdPlan, guardW: '' | 'W') => ({
  ind: '\t',
  ifThen: (test: string, then: string) => `if ${test} ${then}`,
  first: (f: FirstSig) => firstCond(f, 't', ids),
  armJoin: ' ',
  guard: (g: Guard, keyed: boolean, stmt: string) => { const c = guardCond(g, '_ft', guardW, keyed); return ifGo(c.length && !keyed ? ['_ft != nil', ...c] : c, stmt); },
  dispatch: dispatchGoL('_ft'),
  guardConds: (g: Guard) => guardCond(g, '_ft', guardW, false),
  commitSw: commitSwGo('_ft'),
});

// ── The recognize form (ParserIR.forms) ──
// A step that advances and reports whether it matched, building nothing, printed for one of the
// two engines (the native one, `engine`, or the builder one, `parserW`): each has its own cursor
// helpers, so each has its own recognizers, and the names below are those of both.
type GoEngine = {
  recv: string; w: '' | 'W';
  peek: string; ahead: string; matchComp: string;
  bpFound: (name: string, bp: number) => string;   // a Pratt rule parsed at bp, its node dropped
  template: (hole: string) => string;              // an interpolated template matched, its node dropped
  parsed: (name: string) => string;                // a Pratt rule parsed, its node dropped
  mark: string; reset: string;                     // undo everything (a lookahead that builds: Forms.lookBuilds)
};
const ENGINE_GO: GoEngine = {
  recv: 'engine', w: '', peek: 'peek', ahead: 'ahead', matchComp: 'matchComp',
  bpFound: (n, bp) => `(p.bp_${n}(${bp}) >= 0)`, parsed: (n) => `p.parse${n}() >= 0`,
  template: (h) => `(p.matchTemplate_${h}() >= 0)`,
  mark: ckptGo, reset: undoGo,
};
const ENGINE_GO_W: GoEngine = {
  recv: 'parserW', w: 'W', peek: 'peek', ahead: 'ahead', matchComp: 'matchComp',
  bpFound: (n, bp) => `parsedW(p.bpW_${n}(${bp}))`, parsed: (n) => `parsedW(p.parse${n}W())`,
  template: (h) => `parsedW(p.matchTemplateW_${h}())`,
  mark: `${ckptGoW('parserW')};`, reset: undoGoW('parserW'),
};
// The cursor's recognizers (Forms.cursorOnly) run no building form, so nothing here is called.
const CURSOR_GO: GoEngine = {
  recv: 'cursor', w: '', peek: 'peek', ahead: 'ahead', matchComp: 'matchComp',
  bpFound: () => { throw new Error('goTarget: a cursor recognizer runs no Pratt rule'); },
  parsed: () => { throw new Error('goTarget: a cursor recognizer runs no Pratt rule'); },
  template: () => { throw new Error('goTarget: a cursor recognizer matches no interpolated template'); },
  mark: '', reset: '',
};
const branchGoR = (cond: string) => `{ sp := p.pos; if ${cond} { return true }; p.back(sp) }`;
// The step walk's Go spelling (emit-portable.ts, StepLowering) for one engine: the native engine
// building ('', receiver `engine`), the builder engine building ('W', receiver `recv`), or either
// one recognizing ('R', ParserIR.forms; e: whose recognizers). Go: a body or a step's statements
// are a func literal called in place.
type GoForm = '' | 'W' | 'R';
function goSteps(ids: LexIdPlan, f: GoForm, recv: string, e: GoEngine, ar?: ArenaIdPlan): StepLowering {
  // A literal's leaf type (litTt, decided here): a word is a $keyword leaf, anything else $punct.
  const litTt = (lid: number) => (lid >= ids.kwLid ? ttIdOf(ar!, '$keyword') : TT_SKIP_PUNCT);
  const fn = (cond: string) => `func() bool { return ${cond} }`;
  const L: StepLowering = {
    inner: () => L,
    shared: (id) => `p.sub${id}${f}()`,
    lit: (s) => (gtCompLit(ids, s) ? `p.${e.matchComp}(${lidOf(ids, s.value)})` : f === 'W' ? `p.litW(${lidOf(ids, s.value)}) && p.takeW(${litTt(lidOf(ids, s.value))})` : `p.matchLit${f}(${lidOf(ids, s.value)})`),
    tok: (name) => (f === 'W' ? `p.tokW(${kidOf(ids, name)}) && p.takeW(${kidOf(ids, name)})` : `p.matchTok${f}(${kidOf(ids, name)})`),
    template: (name, hole) => `(${f === 'W' ? `(${L.tok(name)})` : L.tok(name)} || ${f === 'R' ? e.template(hole) : f === 'W' ? `p.callRuleW(p.matchTemplateW_${hole}())` : `p.callRule(p.matchTemplate_${hole}())`})`,
    rule: (name) => (f === 'R' ? `p.rec${name}()` : f === 'W' ? `p.callRuleW(p.parse${name}W())` : `p.callRule(p.parse${name}())`),
    // Recognized, a Pratt rule runs its building form and its node is dropped (ParserIR.forms).
    ruleBp: (name, bp) => (f === 'R' ? e.bpFound(name, bp) : f === 'W' ? `p.callRuleW(p.bpW_${name}(${bp}))` : `p.callRule(p.bp_${name}(${bp}))`),
    // A body guard (emit-portable.ts annotateSteps): opt / sep test it before their one attempt,
    // star before each attempt, so a refused attempt takes no mark. A clean body (Step.clean) is
    // attempted without a mark (starC / optC / sepByC).
    star: (body, g, c) => (g === null ? `p.star${c ? 'C' : ''}${f}(${fn(body)})` : `p.starIn${c ? 'C' : ''}${f}(${g}, ${fn(body)})`),
    opt: (body, g, c) => {
      const attempt = `p.opt${c ? 'C' : ''}${f}(${fn(body)})`;
      return g === null ? attempt : `(!p.${e.ahead}(${g}, true) || ${attempt})`;
    },
    sep: (elem, delim, g, c) => {
      const call = `p.sepBy${c ? 'C' : ''}${f}(${fn(elem)}, ${sepDelimLid(ids, delim)})`;
      return g === null ? call : `(!p.${e.ahead}(${g}, true) || ${call})`;
    },
    altlit: (values) => `p.altLit${f}([]uint16{${values.map((v) => lidOf(ids, v)).join(', ')}})`,
    look: (id, is) => `${is ? '' : '!'}p.look${id}()`,   // recognize form (lookFnsR)
    ahead: (set, is) => `p.${e.ahead}(${set}, ${is})`,
    aheadCtx: (set, is) => (is ? `(p.${e.ahead}(${set}, true) || p.ctxWord())` : `(p.${e.ahead}(${set}, false) && !p.ctxWord())`),
    sameLine: () => `func() bool { t := p.${e.peek}(); return t != nil && !t.Nl }()`,
    inPlace: (_kind, stmts) => `func() bool { ${stmts} }()`,
    ret: (cond) => `return ${cond}`,
    // A `ctx` step's body is a boolean expression: no return path leaves between the two assignments.
    suppress: (set, cond) => `p.suppressNext = ${set}; _r := (${cond}); p.suppressNext = 0; return _r`,
    ctx: (ctx, cond) => `_c := p.ctx; p.ctx = ${ctx}; _r := (${cond}); p.ctx = _c; return _r`,
    // A branch that fails clean (Step.clean) has nothing to undo: no frame.
    branch: (cond, clean) => (clean ? `{ if ${cond} { return true } }` : f === 'R' ? branchGoR(cond) : f === 'W' ? branchGoW(cond, recv) : branchGo(cond)),
    guarded: (first, branch) => `if _ft != nil && ${firstCond(first, '_ft', ids)} ${branch}`,
    choice: (peek, tries) => `${peek ? `_ft := p.${e.peek}(); ` : ''}${tries.join('; ')}; return false`,
    // Same-line `} else if`: newlines break Go ASI.
    predictive: (arms) => `t := p.${e.peek}(); if t == nil { return false }; ${arms.map((a) => `if ${firstCond(a.first, 't', ids)} ${a.branch}`).join(' else ')}; return false`,
  };
  return L;
}
const stepCondR = (s: Step, ids: LexIdPlan, e: GoEngine): string => walkExpr(s, goSteps(ids, 'R', e.recv, e));
// ParserIR.lookaheads, one method each, in recognize form: whether the body matches here. It
// undoes the position, and the scratch list and the arena / builder too when its body runs a
// Pratt rule's building form (Forms.lookBuilds).
function lookFnsR(ir: ParserIR, ids: LexIdPlan, e: GoEngine, onCursor: boolean): string {
  return ir.lookaheads.map((body, id) => {
    if (ir.forms.cursorOnly.looks[id] !== onCursor) return '';
    const builds = ir.forms.lookBuilds[id]!;
    return `func (p *${e.recv}) look${id}() bool { ${builds ? e.mark : 'sp := p.pos;'} r := ${body.map((x) => stepCondR(x, ids, e)).join(' && ')}; ${builds ? e.reset : 'p.back(sp)'}; return r }\n`;
  }).join('');
}
function sharedFnsR(ir: ParserIR, ids: LexIdPlan, e: GoEngine, onCursor: boolean): string {
  return ir.shared.map((s, id) => (ir.forms.recognizeShared[id] && ir.forms.cursorOnly.shared[id] === onCursor ? `func (p *${e.recv}) sub${id}R() bool { ${walkStmts(s, goSteps(ids, 'R', e.recv, e))} }\n` : '')).join('');
}
// A rule in recognize form: whether it matches here, advancing past it. An rd rule has rdRule's
// control flow building nothing: its longest match compares end positions only (a tie only
// chooses which node, and none is built). A Pratt rule runs its building form and drops the node.
function ruleR(r: RdRule | PrattRule, ids: LexIdPlan, e: GoEngine): string {
  if (r.kind === 'pratt') return `func (p *${e.recv}) rec${r.name}() bool { return ${e.parsed(r.name)} }`;
  return ruleShell(r, ids, {
    ...goRuleBase(r, ids, e.w),
    steps: goSteps(ids, 'R', e.recv, e),
    fn: (lines) => `func (p *${e.recv}) rec${r.name}() bool {\n${lines.join('\n')}\n}`,
    accept: () => '{ return true }',
    open: () => '\tsave := p.pos',
    peekOrFail: `\tt := p.${e.peek}(); if t == nil { return false }`,
    fail: () => '\tp.back(save)\n\treturn false',
    openBest: () => '\tsave := p.pos; bestPos := save',
    peekOpt: `\t_ft := p.${e.peek}()`,
    cand: (_d, _i, cond) => `{ if ${cond} && p.pos > bestPos { bestPos = p.pos }; p.back(save) }`,
    closeBest: '\tp.pos = bestPos\n\treturn bestPos > save',
    commitPeek: `\t_ft := p.${e.peek}()`,
    commit: (_i, conds, cond, undo, nullable) => commitGo(conds, `{ ${undo ? 'save := p.pos; ' : ''}if ${cond}${nullable ? ' && p.pos > save' : ''} { return true };${undo ? ' p.back(save)' : ''} }`, 'return false'),
    commitFail: '{ return false }',
  });
}
// The recognize forms of the cursor helpers (the same tokens examined, nothing built).
const recognizeHelpersGo = (recv: string) => `func (p *${recv}) matchLitR(lid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1
\tif i >= len(p.toks) || p.toks[i].Lid != lid { return false }
\tp.pos = i + 1
\treturn true
}
func (p *${recv}) matchTokR(kid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1
\tif i >= len(p.toks) || p.toks[i].Kid != kid { return false }
\tp.pos = i + 1
\treturn true
}
func (p *${recv}) starR(once func() bool) bool {
\tfor { sp := p.pos; if !once() { p.back(sp); break } }
\treturn true
}
func (p *${recv}) starInR(k int, once func() bool) bool {
	for p.ahead(k, true) { sp := p.pos; if !once() { p.back(sp); break } }
	return true
}
// A clean body (Step.clean) leaves no trace when it fails: no mark, nothing to undo. Kept out of
// line (go:noinline), as the marked forms already are by Go's inline budget: inlined, these small
// helpers and their closures grew the frames of the large rule functions, and every call of those
// paid for it on paths that never run the helper (dense-semi: parseStmtW / parseDeclW +7.5
// instructions per call, Go builder Ir +5.3%).
//go:noinline
func (p *${recv}) starCR(once func() bool) bool {
\tfor once() {}
\treturn true
}
//go:noinline
func (p *${recv}) starInCR(k int, once func() bool) bool {
\tfor p.ahead(k, true) && once() {}
\treturn true
}
//go:noinline
func (p *${recv}) optCR(body func() bool) bool { body(); return true }
//go:noinline
func (p *${recv}) sepByCR(elem func() bool, delim uint16) bool {
\tif elem() { for p.matchLitR(delim) && elem() {} }
\treturn true
}
func (p *${recv}) optR(body func() bool) bool {
\tsp := p.pos; if !body() { p.back(sp) }; return true
}
func (p *${recv}) sepByR(elem func() bool, delimLid uint16) bool {
\tsp0 := p.pos
\tif !elem() { p.back(sp0); return true }
\tfor {
\t\tif !p.matchLitR(delimLid) { break } // a failed delimiter match changes nothing: no mark before it
\t\tsp2 := p.pos
\t\tif !elem() { p.back(sp2); break }
\t}
\treturn true
}
func (p *${recv}) altLitR(lids []uint16) bool {
\tfor _, lid := range lids { if p.matchLitR(lid) { return true } }
\treturn false
}
`;

/** Emit kid/lid lookup tables into generated lexer source. */
function renderIdTablesGo(ids: LexIdPlan): string {
  const kidsLit = ids.kids.map(J).join(', ');
  const lidsLit = ids.lids.map(J).join(', ');
  const pf = buildLidPrefilter(ids, UNITS);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  // The literal table as two string switches (words, the rest: buildLidTables), which the Go
  // compiler turns into a search by length and value; no map is built at load time.
  const tables = buildLidTables(ids, UNITS);
  const cases = (half: [number, { text: string; id: number }[]][]) => half.flatMap(([, ents]) => ents).map((e) => `\tcase ${J(e.text)}:\n\t\treturn ${e.id}\n`).join('');
  // The byte test of lidWordByte, as ranges of consecutive bytes (a package-level table would be mutable state).
  const wordTest: string[] = [];
  for (let b = 0; b < 256; b++) {
    if (!lidWordByte(b) || lidWordByte(b - 1)) continue;
    let e = b;
    while (e < 255 && lidWordByte(e + 1)) e++;
    wordTest.push(e === b ? `b == ${b}` : `(b >= ${b} && b <= ${e})`);
  }
  return `var kindStr = []string{${kidsLit}}
var _lids = []string{${lidsLit}}
const _lidMaxLen = ${pf.maxLen}
var _lidFirstBits = [...]byte{${bitsLit}}

// lidKeyIsLiteral is the length x first-byte prefilter: false when no literal has the text's key.
func lidKeyIsLiteral(text string) bool {
\tn := len(text)
\tif n == 0 || n > _lidMaxLen { return false }
\tb0 := text[0]
\treturn _lidFirstBits[n*32+(int(b0)>>3)]&(1<<(b0&7)) != 0
}
// lidOf is the literal id of a text (0: no literal): the prefilter, then the table half of its first byte.
func lidOf(text string) uint16 {
\tif !lidKeyIsLiteral(text) { return 0 }
\tif b := text[0]; ${wordTest.join(' || ')} { return lidOfKw(text) }
\treturn lidOfPunct(text)
}
// lidOfWord is lidOf for a token whose kind can equal word literals only (shared.tokenLiterals).
func lidOfWord(text string) uint16 {
\tif !lidKeyIsLiteral(text) { return 0 }
\treturn lidOfKw(text)
}
func lidOfKw(text string) uint16 {
\tswitch text {
${cases(tables.word)}\t}
\treturn 0
}
func lidOfPunct(text string) uint16 {
\tswitch text {
${cases(tables.rest)}\t}
\treturn 0
}
func tokKind(t *Tok) string { return kindStr[t.Kid] }
func tokText(src string, t *Tok) string { return src[t.Off:t.End] }
func mkTok(off, end int, nl bool, kid, lid uint16) Tok { return Tok{Off: uint32(off), End: uint32(end), Kid: kid, Lid: lid, Nl: nl} }
`;
}

/** Emit TT_NAMES / RULE_NAMES lookup tables for arena slim encoding. */
function renderArenaTablesGo(ar: ArenaIdPlan, ids: LexIdPlan): string {
  return `var TT_NAMES = []string{${ar.ttNames.map(J).join(', ')}}
var RULE_NAMES = []string{${ar.ruleNames.map(J).join(', ')}}
const TT_SKIP_PUNCT = ${TT_SKIP_PUNCT}
// lidKw: the first word lid (LexIdPlan.kwLid). A literal from here on is a $keyword leaf, one
// before it a $punct (no leaf); litTt is its leaf type id.
const lidKw = ${ids.kwLid}
func litTt(lid uint16) uint16 { if lid >= lidKw { return ${ttIdOf(ar, '$keyword')} }; return TT_SKIP_PUNCT }
`;
}

// The literal id of a token whose text is `text`, given the literals its kind can be
// (shared.tokenLiterals): 0 when it can be none.
const lidCallGo = (lits: string[], text: string): string => (lits.length === 0 ? '0' : lits.every((l) => lidWordByte(firstUnit(l, UNITS))) ? `lidOfWord(${text})` : `lidOf(${text})`);

// Whether a skipped token's text holds a line terminator (LF, CR, U+2028, U+2029): byte searches,
// no decode.
const GO_HAS_LINE_TERM = `// lexHasLineTerm is whether s holds a line terminator (LF, CR, U+2028, U+2029).
func lexHasLineTerm(s string) bool {
\treturn strings.IndexByte(s, '\\n') >= 0 || strings.IndexByte(s, '\\r') >= 0 || strings.Contains(s, "\\u2028") || strings.Contains(s, "\\u2029")
}
`;

/** uni-ident.ts's identifier classes and their lookup. Go's `unicode` package has the general
 *  categories but no ID_Start / ID_Continue (Other_ID_Start, Pattern_Syntax), hence the table;
 *  a const string, since Go has no compile-time evaluation to decode a denser form into. */
function goUniIdentTables(): string {
  const p = uniIdentPlan();
  const l = uniLookup(p, (k) => `uint32(_uniT[${k}])`);
  return `const _uniT = "${p.data.replace(/\\/g, '\\\\')}"
// uni-ident.ts's class of r: 0 neither, 1 IdentifierPart only, 2 IdentifierStart too.
func uniClass(r rune) uint32 {
	cp := uint32(r)
	if cp < ${p.flatLen} { return ${l.flat} }
	if ${l.top} >= ${p.topLen} { return 0 }
	var i uint32
${l.steps.map((e) => `\ti = ${e}\n\tif i < ${l.uniform} { return i }\n`).join('')}\treturn ${l.result}
}
`;
}

const GO_LEX_ERR = `// lexErr is a lexer error (relex-family.ts): its kind, offset and end; lexError spells its message.
type lexErr struct { Kind, Off, End int }
// lexTplErr is the lexer error of a template span (-1 unterminated, -2 - q an invalid escape at q).
func lexTplErr(q, n int) *lexErr {
\tif q == -1 { return &lexErr{Kind: 2, Off: n} }
\treturn &lexErr{Kind: 3, Off: -2 - q}
}
`;
// A lexer error (relex-family.ts LexErr): recorded, and the lex ends: a jump to the loop's exit,
// `lexFail` (with a type-parameter signature undecided, the exit returns to the loop, whose head
// rewinds it). Go: an error path that continued the loop would carry err around every iteration
// (a loop phi); the jump leaves the loop's own state as it was.
const goFail = (kind: string, off: string, end: string): string => `err = &lexErr{Kind: ${kind}, Off: ${off}, End: ${end}}; goto lexFail`;

// One token at a dispatch site: the shared scanner, spliced in, says where it ends; the lexer
// records it.
function scanTok(ir: ParserIR, t: LexTok, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, identLike: Set<string>): string {
  const name = t.name;
  const kid = kidOf(ids, name);
  const push = t.skip
    ? `if lexHasLineTerm(src[pos:e]) { pendingNl = true }; `
    : `${stateful ? 'emit' : 'pushTok'}(pos, e, ${kid}, ${lidCallGo(shared.tokenLiterals(ir, t, ids.lids.slice(1)), 'src[pos:e]')}); `;
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (emit-lexer.ts).
  const ext = identLike.has(name) ? 'e = lxExt(src, e); ' : '';
  const body = shared.scanInline(ir, name, { s: 'src', p: 'pos', out: 'e' });
  // An identifier whose escapes spell no IdentifierName is the lexer error -2 - e (lex-family.ts).
  const escErr = identLike.has(name) ? [`if e < -1 { ${goFail('1', 'pos', '-2 - e')} }`] : [];
  const scan = ['{', ...goBlock([...body, `if e >= 0 { ${ext}${push}pos = e; continue }`, ...escErr]), '}'];
  const lines = rxTok !== undefined && name === rxTok ? ['if !prevIsValue() {', ...goBlock(scan), '}'] : scan;
  return lines.map((l) => `\t\t${l}`).join('\n');
}

function buildLexCandidates(
  ir: ParserIR, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined,
  punctLine: (p: string) => string,
): { codes: string[]; firsts: (LexFirstBytes | null)[] } {
  const identLike = new Set(ir.identLike);
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of shared.scannedTokens(ir)) {
    codes.push(scanTok(ir, t, shared, stateful, ids, rxTok, identLike));
    firsts.push(lexTokFirstBytes(t));
  }
  for (const p of ir.puncts) {
    codes.push(punctLine(p));
    firsts.push(punctFirstBytes(p));
  }
  return { codes, firsts };
}

/** Shared first-byte dispatch for all lexFrom variants in this target. */
// `heads`: per ASCII byte, code that runs first in that byte's arm (and nowhere else), for a test
// only that byte can pass; a byte no candidate starts with gets an arm of its own.
// The lexer of a grammar with an element region (ElementPlan): the frame stack is the template
// stack, and the frame decisions are the shared family's (lex-family.ts elementFns); what is here
// is their placement in the dispatch loop, the token push, and the type-parameter signature's
// speculation (lexed as code to its verdict, then rewound: docs/REGIONS.md).
function elementLexerGo(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms, p: {
  head: string; scans: string; rxStateFrom: string; nlWs: string; lexCodes: string[]; lexFirsts: (LexFirstBytes | null)[];
  tplCloseTest: string; tplOpenTest: string; uniIdentFallbackGo: string; loopPanicGo: string; goBoolArr: (name: string, flags: boolean[]) => string;
}): string {
  const el = ir.elements!, rx = ir.regexCtx, tpl = ir.tpl, sig = el.signature, raw = el.rawText.length > 0;
  const operand = el.entry === 'operand';
  if (operand && !rx) throw new Error('portable: an operand element entry needs the regex context (prevIsValue)');
  const L = tlen(el.tagOpen);
  const consts = `const lidElOpen uint16 = ${lidOf(ids, el.tagOpen)}
const lidElClose uint16 = ${lidOf(ids, el.tagClose)}
const lidHoleOpen uint16 = ${lidOf(ids, el.holeOpen)}
const lidHoleClose uint16 = ${lidOf(ids, el.holeClose)}
const lidEq uint16 = ${lidOf(ids, '=')}
${sig ? `${p.goBoolArr('_elThen', lidFlagTable(ids, sig.then))}\n` : ''}`;
  // prevIsValue: in a tag nothing is a regex; the token that ended an element is a value.
  const prevIsValue = p.rxStateFrom.replace('\tprevIsValue := func() bool {\n', `\tprevIsValue := func() bool {
\t\tif len(*acc) <= valueTo { return true }
`);
  const rxParams = rx ? 'prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, ' : '';
  const rxRet = rx ? 'uint16, uint16, uint16, bool, bool, []bool, bool, bool, ' : '';
  const rxNames = rx ? 'prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, ' : '';
  const rxInit = rx ? '0, 0, 0, false, false, stk.parenHead[:0], false, false, ' : '';
  const rxBlank = rx ? '_, _, _, _, _, stk.parenHead, _, _, ' : '';
  // hot: whether the loop head has work (an element or raw frame on top of the frame stack${sig ? ', or a
  // signature undecided' : ''}), kept by every change of the stack's top${sig ? ' and of the speculation' : ''}; elEndAt: the token
  // count after the token that ended an element (that token is a value).
  const hotState = `\thot, elEndAt${rx ? ', valueTo' : ''} := false, -1${rx ? ', -1' : ''}
\tif elEnded { elEndAt = len(*acc) }
`;
  // after the speculation's state (it reads specTok), before its rewind (which calls it)
  // valueTo: to which token count the previous token is a value (in a tag: every; else the token
  // that ended an element, while it is the last).
  const refreshFn = `\trefresh := func() {
\t\ttop := 0
\t\tif len(templateStack) > 0 { top = templateStack[len(templateStack)-1] }
\t\thot = ${sig ? 'specTok >= 0 || ' : ''}top&2 != 0
${rx ? `\t\tvalueTo = elEndAt
\t\tif top&3 == 2 && top&12 != 0 { valueTo = 1 << 62 }
` : ''}\t}
\trefresh()
`;
  const specState = sig ? `\t// A type-parameter signature being decided: the token index of its tagOpen (-1: none), the
\t// state before it, how it was decided (a lexer error decides it: the head was an element), and
\t// the decision kept for the tagOpen it rewinds to.
\tspecTok, specSeen, specBase, specClosedAt, specOff, specEnd, specAt := -1, 0, 0, -1, 0, 0, -1
\tspecDone, specThen, specKeep := false, false, false
\tsvPos, svNl, svPrevLid, svPrevKid, svBpLid, svHasPrev, svHasPrev2, svLastClose, svLastBang, svElEndAt, svAngle := 0, false, uint16(0), uint16(0), uint16(0), false, false, false, false, -1, 0
\tvar svParen []bool
\tvar svStack []int
${refreshFn}\t// Each token the speculation lexes, read at the next loop head (a round lexes one token at most):
\t// a closer that leaves the bracket stack at the signature's base (even by popping an empty one)
\t// closes the group, again if it was closed; the token after the closer decides. Whether decided.
\tspecStep := func() bool {
\t\tif i := len(*acc) - 1; i >= specSeen {
\t\t\tspecSeen = i + 1
\t\t\tt := (*acc)[i]
\t\t\tif t.Lid == lidRParen && i > specTok+3 && len(parenHead) == specBase { specClosedAt = i } else if specClosedAt >= 0 && i > specClosedAt { specClosedAt = -1; specDone = true; specThen = t.Kid == 0 && _elThen[t.Lid]; specOff = int(t.Off); specEnd = int(t.End) }
\t\t}
\t\treturn specDone
\t}
\t// The rewind to the signature's tagOpen: its position (pos and limit stay the loop's own locals;
\t// failed: a lexer error decided it; err is the loop's, not captured here: a captured variable is
\t// not kept in a register).
\tspecRewind := func(failed bool) int {
\t\tkeep := specDone && !failed && specThen
\t\tre := n + 1
\t\tif specDone && !failed { re = ${shared.elementFn('reach')}(src, specEnd) }
\t\tif re > laEnd { laEnd = re }
\t\tif keep { specUntil = specOff }
\t\tspecAt = svPos; specKeep = keep
\t\t*acc = (*acc)[:specTok]
\t\tpendingNl = svNl; prevLid = svPrevLid; prevKid = svPrevKid; bpLid = svBpLid; hasPrev = svHasPrev; hasPrev2 = svHasPrev2
\t\tlastClose = svLastClose; lastBang = svLastBang; elEndAt = svElEndAt; tagAngle = svAngle
\t\tparenHead = append(parenHead[:0], svParen...)
\t\ttemplateStack = append(templateStack[:0], svStack...)
\t\tspecTok = -1; specClosedAt = -1; specDone = false
\t\trefresh()
\t\treturn svPos
\t}
` : '';
  const emitFn = `\temit := func(off, end int, kid, lid uint16) {
${rx ? `\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
` : ''}\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false${rx ? '\n\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true' : ''}
\t}
\t_ = emit
`;
  // The entry from code, in the tagOpen byte's dispatch arm (outside element frames: inside one
  // the frame step lexes every tagOpen).
  const enter = `\t\t\ttemplateStack = append(templateStack, 6); refresh(); bound = 0; emit(pos, pos + ${L}, 0, lidElOpen);${raw ? ' tagAt = append(tagAt, len(*acc)-1);' : ''} tagAngle = 0; pos += ${L}; continue\n`;
  const entry = !operand ? `\t\tif strings.HasPrefix(src[pos:], ${J(el.tagOpen)}) {\n${enter}\t\t}\n`
    : !(el.head || sig) ? `\t\tif strings.HasPrefix(src[pos:], ${J(el.tagOpen)}) && !prevIsValue() {\n${enter}\t\t}\n`
    : `\t\tif strings.HasPrefix(src[pos:], ${J(el.tagOpen)})${sig ? ' && specTok < 0 && pos >= specUntil' : ''} && !prevIsValue() {
\t\t\top := 0
\t\t\t${sig ? 'if pos == specAt { op = 1; if specKeep { op = 0 }; specAt = -1 } else ' : ''}{ o, re := ${shared.elementFn('opens')}(src, pos); op = o; if re > laEnd { laEnd = re } }
\t\t\tif op == 1 {
${enter}\t\t\t}
${sig ? `\t\t\tif op == 2 {
\t\t\t\tsvPos, svNl, svPrevLid, svPrevKid, svBpLid, svHasPrev, svHasPrev2 = pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2
\t\t\t\tsvLastClose, svLastBang, svElEndAt, svAngle = lastClose, lastBang, elEndAt, tagAngle
\t\t\t\tsvParen = append(svParen[:0], parenHead...)
\t\t\t\tsvStack = append(svStack[:0], templateStack...)
\t\t\t\tspecTok = len(*acc); specSeen = specTok; specBase = len(parenHead); specClosedAt = -1; specDone = false; hot = true; bound = 0
\t\t\t}
` : ''}\t\t}
`;
  // An element hole's closer at brace count 0 ends it (the closer is lexed inside the frame).
  const holeClose = `\t\tif len(templateStack) > 0 && templateStack[len(templateStack)-1] == 1 && strings.HasPrefix(src[pos:], ${J(el.holeClose)}) {
\t\t\temit(pos, pos + ${tlen(el.holeClose)}, 0, lidHoleClose); templateStack = templateStack[:len(templateStack)-1]; refresh(); if hot { bound = 0 }; pos += ${tlen(el.holeClose)}; continue
\t\t}
`;
  const heads = new Map<number, string>();
  const headByte = (t: string) => { const b = Buffer.from(t, 'utf8')[0]!; return b < 128 && ![9, 10, 11, 12, 13, 32].includes(b) ? b : null; };
  let pre = '';
  const place = (lit: string, code: string) => { const u = headByte(lit); if (u === null) pre += code; else heads.set(u, (heads.get(u) ?? '') + code); };
  place(el.tagOpen, entry);
  place(el.holeClose, holeClose);
  if (tpl) { place(tpl.interpClose, p.tplCloseTest); place(tpl.open, p.tplOpenTest); }
  const cascade = renderLexByteDispatchGo(p.lexCodes, p.lexFirsts, '\t', heads);
  const frameStep = `\t\tif len(templateStack) > 0 && templateStack[len(templateStack)-1]&3 == 2 {
\t\t\tfr := templateStack[len(templateStack)-1]
\t\t\tfe, fk, fl, ft, fp, fa, fla := ${shared.elementFn('frame')}(src, pos, fr, tagAngle, len(*acc) > 0 && (*acc)[len(*acc)-1].Lid == lidEq, laEnd)
\t\t\tlaEnd = fla
\t\t\tif fe >= 0 {
\t\t\t\temit(pos, fe, uint16(fk), uint16(fl))
${raw ? `\t\t\t\t// each element frame's current tag: the index of its tagOpen token (the name is the next)
\t\t\t\tif uint16(fl) == lidElOpen { if fp == 6 { tagAt = append(tagAt, len(*acc)-1) } else if (fr>>2)&3 == 0 { tagAt[len(tagAt)-1] = len(*acc) - 1 } }
` : ''}\t\t\t\tif ft < 0 { templateStack = templateStack[:len(templateStack)-1];${raw ? ' tagAt = tagAt[:len(tagAt)-1];' : ''} elEndAt = len(*acc) } else { templateStack[len(templateStack)-1] = ft }
\t\t\t\tif fp != 0 { templateStack = append(templateStack, fp) }
${raw ? `\t\t\t\t// an open tag ended: a raw-text name gives its body to a raw frame (kind 3), lexed next
\t\t\t\tif uint16(fl) == lidElClose && (fr>>2)&3 == 1 && tagAngle == 0 {
\t\t\t\t\tif i := tagAt[len(tagAt)-1] + 1; i < len(*acc)-1 {
\t\t\t\t\t\tif re, rk := ${shared.elementFn('raw')}(src, int((*acc)[i].Off), int((*acc)[i].End), fe); rk != 0 && re > fe { templateStack = append(templateStack, 3) }
\t\t\t\t\t}
\t\t\t\t}
` : ''}\t\t\t\trefresh(); tagAngle = fa; pos = fe; continue
\t\t\t}
\t\t}
${raw ? `\t\tif len(templateStack) > 0 && templateStack[len(templateStack)-1] == 3 {
\t\t\ti := tagAt[len(tagAt)-1] + 1
\t\t\tre, rk := ${shared.elementFn('raw')}(src, int((*acc)[i].Off), int((*acc)[i].End), pos)
\t\t\temit(pos, re, uint16(rk), 0); templateStack = templateStack[:len(templateStack)-1]; refresh(); pos = re; continue
\t\t}
` : ''}`;
  // Code outside element frames pays one test per round (hot); the loop condition is the plain
  // lexer's. A speculation lexes past the token limit to its verdict (the limit is tested first); one
  // that reaches the end of the input (or a lexer error, its verdict) is rewound after the loop.
  // The plain rounds (code outside element frames) are the inner loop, whose only bound is
  // \`bound\`: the input's end while no element work is pending, so its condition is the plain
  // lexer's; one round (pos + 1) after the frame step lexed nothing; 0 once a round makes work (an
  // element entered or back on top${sig ? ', a signature begun' : ''}). The work (hot, kept by every change of the
  // frame stack's top${sig ? ' and of the speculation' : ''}) is the outer loop's, so no plain round tests it.
  // A lexer error jumps to lexFail (goFail)${sig ? '; with a signature undecided it is the verdict' : ''}.
  const more = `pos < n && (limit <= 0 || len(*acc)-base < limit${sig ? ' || specTok >= 0' : ''})`;
  const loop = `${sig ? 'lexLoop:\n' : ''}\tfor {
\t\tif !(${more}) {
${sig ? '\t\t\tif specTok >= 0 { specStep(); pos = specRewind(false); continue }\n' : ''}\t\t\tbreak
\t\t}
\t\tbound := n
\t\tif hot {
${sig ? '\t\tif specTok >= 0 && specStep() { pos = specRewind(false); continue }\n' : ''}${frameStep}\t\tbound = pos + 1
\t\t}
\tfor pos < bound && (limit <= 0 || len(*acc)-base < limit${sig ? ' || specTok >= 0' : ''}) {
\t\tc := int(src[pos])
${p.nlWs}${pre}${cascade}
${p.uniIdentFallbackGo}${p.loopPanicGo}
\t}
\t}
`;
  return `${p.head}${consts}${p.scans}func lexFrom(src string, pos int, pendingNl bool, ${rxParams}templateStack []int, elEnded bool, tagAngle, laEnd, specUntil int, ${raw ? 'tagAt []int, ' : ''}acc *[]Tok, limit int) (int, bool, ${rxRet}[]int, bool, int, int, int${raw ? ', []int' : ''}, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${hotState}${prevIsValue}${sig ? '' : refreshFn}${specState}${emitFn}\tbase := len(*acc)
${loop}lexFail:
${sig ? '\tif specTok >= 0 { specStep(); pos = specRewind(err != nil); err = nil; goto lexLoop }\n' : ''}\treturn pos, pendingNl, ${rxNames}templateStack, len(*acc) == elEndAt, tagAngle, laEnd, specUntil${raw ? ', tagAt' : ''}, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\tvar err *lexErr
\t_, _, ${rxBlank}stk.templateStack, _, _, _, _${raw ? ', _' : ''}, err = lexFrom(src, 0, false, ${rxInit}stk.templateStack[:0], false, 0, 0, 0, ${raw ? 'nil, ' : ''}&out, 0)
\treturn out, err
}`;
}

function renderLexByteDispatchGo(codes: string[], firsts: (LexFirstBytes | null)[], indent: string, heads: Map<number, string> = new Map()): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let switchArms = '';
  for (const [byte, code] of heads) if (!arms.some((a) => a.bytes.includes(byte))) switchArms += `${indent}\tcase ${byte}:\n${code}`;
  for (const arm of arms) {
    switchArms += `${indent}\tcase ${arm.bytes.join(', ')}:\n`;
    for (const b of arm.bytes) switchArms += heads.get(b) ?? '';
    switchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
  }
  return `${indent}if c >= 128 {
${fallback}
${indent}} else {
${indent}\tswitch c {
${switchArms}${indent}\t}
${indent}}`;
}

// Newline mode: every line break outside flow delimiters is a NEWLINE token spanning the break.
function newlinePartsGo(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; table: string; ws: string; hooks: string } {
  const kidNl = kidOf(ids, nl.token);
  return {
    state: `\tflowDepth := 0
`,
    stateFrom: '',
    table: `var _flowD = [${ids.lids.length}]int8{${lidDeltaTable(ids, nl.flowOpen, nl.flowClose).join(', ')}}
`,
    ws: `\t\tif c == 32 || c == 9 || c == 11 || c == 12 {
\t\t\tpos++
\t\t\tfor pos < n { if d := src[pos]; d != 32 && d != 9 && d != 11 && d != 12 { break }; pos++ }
\t\t\tcontinue
\t\t}
\t\tif c == 10 || c == 13 {
\t\t\ts := pos
\t\t\tpos++; if c == 13 && pos < n && src[pos] == 10 { pos++ }
\t\t\tif flowDepth == 0 { ${pushFn}(s, pos, ${kidNl}, 0) }
\t\t\tpendingNl = true
\t\t\tcontinue
\t\t}
\t\tif c >= 0x80 {
\t\t\t// LS/PS excluded: they fall to the unexpected-character panic, matching the interpreter.
\t\t\tr, w := utf8.DecodeRuneInString(src[pos:])
\t\t\tif isJsWs(r) && r != 0x2028 && r != 0x2029 { pos += w; continue }
\t\t}
`,
    hooks: `\t\tif kid == 0 { if d := int(_flowD[lid]); d != 0 { flowDepth += d; if flowDepth < 0 { flowDepth = 0 } } }
`,
  };
}

function lexer(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
  const scanFns = shared.lexScan(ir);
  const scans = scanFns ? scanFns + '\n' : '';
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const rxOnly = !!(rx && !tpl && !nl);
  const tplOnly = !!(tpl && !rx && !nl);
  const rxTpl = !!(rx && tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly && !tplOnly && !rxTpl;
  const el = ir.elements;
  const stateful = !!(rx || tpl || el);
  const newlineOnly = !!(nl && !rx && !tpl);
  const pushPunct = stateful
    ? (p: string) => `emit(pos, pos + ${tlen(p)}, 0, ${lidOf(ids, p)})`
    : (p: string) => `pushTok(pos, pos + ${tlen(p)}, 0, ${lidOf(ids, p)})`;
  // An element grammar's hole braces count where they are lexed as punctuation (elementBraceSteps).
  const braceSteps = el ? elementBraceSteps(ir) : new Map<string, { delta: number; kinds: number[] }>();
  const braceStep = (p: string): string => {
    const b = braceSteps.get(p);
    return b ? `if k := len(templateStack) - 1; k >= 0 && ${b.kinds.length === 2 ? 'templateStack[k]&2 == 0' : `templateStack[k]&3 == ${b.kinds[0]}`} { templateStack[k] ${b.delta > 0 ? '+=' : '-='} ${Math.abs(b.delta)} }; ` : '';
  };
  const punctLine = (p: string) =>
    `\t\tif strings.HasPrefix(src[pos:], ${J(p)}) { ${braceStep(p)}${pushPunct(p)}; pos += ${tlen(p)}; continue }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, shared, stateful, ids, rx?.regexToken, punctLine);
  const goBoolArr = (name: string, flags: boolean[]) =>
    `var ${name} = []bool{${flags.map((b) => (b ? 'true' : 'false')).join(', ')}}`;
  const rxBitTables = rx ? `${goBoolArr('_divT', lidFlagTable(ids, rx.divisionTexts))}
${goBoolArr('_divK', kidFlagTable(ids, rx.divisionTypes))}
${goBoolArr('_rxT', lidFlagTable(ids, rx.regexTexts))}
${goBoolArr('_phK', lidFlagTable(ids, rx.parenHeadKw))}
${goBoolArr('_mem', lidFlagTable(ids, rx.memberAccess))}
${goBoolArr('_pav', lidFlagTable(ids, rx.postfixAfterValue))}
const kidIdent uint16 = ${kidOf(ids, rx.identToken)}
const lidLParen uint16 = ${lidOf(ids, '(')}
const lidRParen uint16 = ${lidOf(ids, ')')}
` : '';
  const tplLidConsts = tpl ? `const lidBraceOpen uint16 = ${lidOf(ids, tpl.braceOpen)}
const lidInterpClose uint16 = ${lidOf(ids, tpl.interpClose)}
` : '';
  const rxModuleConsts = `${rxBitTables}${tplLidConsts}`;
  const rxState = rx ? `\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tparenHead := stk.parenHead[:0]
\tlastClose, lastBang := false, false
\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevLid] { return lastBang }
\t\tisExprKw := prevKid == kidIdent && _rxT[prevLid] && !(hasPrev2 && _mem[bpLid])
\t\tisParenHead := prevLid == lidRParen && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKid] || _divT[prevLid])
\t}
` : '';
  const tplState = tpl ? `\ttemplateStack := stk.templateStack[:0]
` : '';
  const emitHooks = [
    rx ? `\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }` : '',
    tpl ? `\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }` : '',
    nl ? newlinePartsGo(nl, 'emit', ids).hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true` : '';
  const emitFn = stateful ? `\temit := func(off, end int, kid, lid uint16) {
${emitHooks}
\t\ttoks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false${emitTail}
\t}
\t_ = emit
` : '';
  const rxStateFrom = rx ? `\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevLid] { return lastBang }
\t\tisExprKw := prevKid == kidIdent && _rxT[prevLid] && !(hasPrev2 && _mem[bpLid])
\t\tisParenHead := prevLid == lidRParen && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKid] || _divT[prevLid])
\t}
` : '';
  const emitRxOnly = rx ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true
\t}
\t_ = emit
` : '';
  const emitTplOnly = tpl ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = emit
` : '';
  const emitRxTpl = (rx && tpl) ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true
\t}
\t_ = emit
` : '';
  // The template tests can pass only at their delimiter's first byte: when that byte is ASCII
  // (and not whitespace, which is consumed before the dispatch) the test is made in that byte's
  // dispatch arm, before the arm's own candidates, not in every round.
  const tplHeads = new Map<number, string>();
  const tplLits = shared.templateLiterals(ir, ids.lids.slice(1));
  const headByte = (t: string) => { const b = Buffer.from(t, 'utf8')[0]!; return b < 128 && ![9, 10, 11, 12, 13, 32].includes(b) ? b : null; };
  // The span itself is the shared family's scanner; this reads which delimiter ended it (or its
  // lexer error).
  // The element lexer keeps whether the frame stack's top has work (its refresh).
  const elRefresh = ir.elements ? 'refresh(); ' : '';
  // a closer can bring an element frame back on top: the round ends the plain rounds (bound)
  const elRefreshClose = ir.elements ? 'refresh(); if hot { bound = 0 }; ' : '';
  const tplSpanGo = (from: string, strict: string): string => `\t\t\tq := ${shared.tplSpan()}(src, ${from}, ${strict})
\t\t\tif q < 0 { err = lexTplErr(q, n); goto lexFail }
\t\t\tinterp, e := strings.HasPrefix(src[q:], ${J(tpl!.interpOpen)}), q + ${tlen(tpl!.open)}
\t\t\tif interp { e = q + ${tlen(tpl!.interpOpen)} }
`;
  const tplCloseTest = tpl ? `\t\tif len(templateStack) > 0 && strings.HasPrefix(src[pos:], ${J(tpl.interpClose)}) && templateStack[len(templateStack)-1] == 0 {
\t\t\ttemplateStack = templateStack[:len(templateStack)-1]
${tplSpanGo('pos + ' + tlen(tpl.interpClose), 'false')}\t\t\tif interp { emit(pos, e, ${kidOf(ids, '$templateMiddle')}, ${lidCallGo(tplLits.middle, 'src[pos:e]')}); templateStack = append(templateStack, 0) } else { emit(pos, e, ${kidOf(ids, '$templateTail')}, ${lidCallGo(tplLits.tail, 'src[pos:e]')}) }
\t\t\t${elRefreshClose}pos = e; continue
\t\t}
` : '';
  const tplOpenTest = tpl ? `\t\tif strings.HasPrefix(src[pos:], ${J(tpl.open)}) {
${tplSpanGo('pos + ' + tlen(tpl.open), rx ? '!prevIsValue()' : 'true')}\t\t\tif interp { emit(pos, e, ${kidOf(ids, '$templateHead')}, ${lidCallGo(tplLits.head, 'src[pos:e]')}); templateStack = append(templateStack, 0) } else { emit(pos, e, ${kidOf(ids, tpl.token)}, ${lidCallGo(tplLits.whole, 'src[pos:e]')}) }
\t\t\t${elRefresh}pos = e; continue
\t\t}
` : '';
  let tplDispatch = '';
  if (tpl) for (const [t, code] of [[tpl.interpClose, tplCloseTest], [tpl.open, tplOpenTest]] as const) {
    const hb = headByte(t);
    // Two tests at one byte keep their order; a test whose byte has no arm of its own stays here.
    if (hb !== null && tplDispatch === '') tplHeads.set(hb, (tplHeads.get(hb) ?? '') + code);
    else tplDispatch += code;
  }
  const cascade = renderLexByteDispatchGo(lexCodes, lexFirsts, '\t', tplHeads);
  const identNameGo = ir.identToken;
  const identKidGo = identNameGo ? kidOf(ids, identNameGo) : 0;
  const lexGoHelpers = (nl ? newlinePartsGo(nl, 'emit', ids).table : '') + (shared.scannedTokens(ir).some((t) => t.skip) ? GO_HAS_LINE_TERM : '') + ((identNameGo || ir.identLike.length) ? `func isJsWs(r rune) bool {
	if r == 0xA0 || r == 0x1680 || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF {
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
${goUniIdentTables()}func scanUniIdent(src string, pos int) (int, bool) {
	r, w := utf8.DecodeRuneInString(src[pos:])
	if uniClass(r) != 2 { return pos, false }
	return lxExtRun(src, pos+w), true
}
func ${shared.uniClass()}(cp int) int { return int(uniClass(rune(cp))) }
// Extend an identifier token that the ASCII pattern cut short at a non-ASCII
// ID_Continue char (caf|é → café), mirroring emit-lexer's uniIdentContReY extension.
func lxExt(src string, e int) int {
	if e >= len(src) || src[e] < 0x80 { return e }
	return lxExtRun(src, e)
}
func lxExtRun(src string, e int) int {
	for e < len(src) {
		r, w := utf8.DecodeRuneInString(src[e:])
		if uniClass(r) == 0 { break }
		e += w
	}
	return e
}
` : `func isJsWs(r rune) bool {
	if r == 0xA0 || r == 0x1680 || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF {
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
`);
  const nlState = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).state : '';
  const nlStateFrom = nl ? newlinePartsGo(nl, 'pushTok', ids).stateFrom : '';
  // A whitespace run is consumed in one dispatch round (see the Rust target): per byte only "is
  // it still whitespace"; a run after a line break also takes further breaks.
  const nlWs = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).ws : `\t\tif c == 32 || c == 9 || c == 11 || c == 12 {
\t\t\tpos++
\t\t\tfor pos < n { if d := src[pos]; d != 32 && d != 9 && d != 11 && d != 12 { break }; pos++ }
\t\t\tcontinue
\t\t}
\t\tif c == 10 || c == 13 {
\t\t\tpendingNl = true
\t\t\tpos++
\t\t\tfor pos < n { if d := src[pos]; d != 32 && (d < 9 || d > 13) { break }; pos++ }
\t\t\tcontinue
\t\t}
\t\tif c >= 0x80 {
\t\t\tr, w := utf8.DecodeRuneInString(src[pos:])
\t\t\tif isJsWs(r) { if r == 0x2028 || r == 0x2029 { pendingNl = true }; pos += w; continue }
\t\t}
`;
  const pushHooks = nl && !stateful ? newlinePartsGo(nl, 'pushTok', ids).hooks : '';
  const pushTokFn = stateful ? '' : nl
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\ttoks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { toks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }\n\t_ = pushTok\n`;
  const uniIdentPushGo = stateful ? 'emit' : 'pushTok';
  const uniIdentFallbackGo = identNameGo
    ? `\t\tif c >= 0x80 {
\t\t\tif e, ok := scanUniIdent(src, pos); ok {
\t\t\t\t${uniIdentPushGo}(pos, e, ${identKidGo}, lidOf(src[pos:e])); pos = e; continue
\t\t\t}
\t\t}
`
    : '';
  const loopPanicGo = `\t\t${goFail('0', 'pos', 'pos')}`;
  const pushTokAccFn = nl && !stateful
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { *acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }
\t_ = pushTok
`;
  const loopBody = `\t\tc := int(src[pos])
${nlWs}${tplDispatch}${cascade}
${uniIdentFallbackGo}${loopPanicGo}`;
  const idTables = renderIdTablesGo(ids);
  // The lexer's bracket-head and template-depth stacks, bounded by nesting depth: lexInto reuses
  // the capacity of the ones in stk (a reused builder's) and leaves them there.
  const stkFields = [rx ? '\tparenHead []bool\n' : '', tpl || el ? '\ttemplateStack []int\n' : ''].join('');
  const lexStacks = `// lexStacks are the lexer's transient stacks, kept across lexes by a reused builder.
type lexStacks struct {${stkFields ? `\n${stkFields}` : ''}}
${GO_LEX_ERR}`;
  if (el) return elementLexerGo(ir, ids, shared, { head: `${idTables}${lexStacks}${lexGoHelpers}${rxModuleConsts}`, scans, rxStateFrom, nlWs, lexCodes, lexFirsts, tplCloseTest, tplOpenTest, uniIdentFallbackGo, loopPanicGo, goBoolArr });
  if (rxOnly) {
    return `${idTables}${lexStacks}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${rxStateFrom}${emitRxOnly}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
lexFail:
\treturn pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\tvar err *lexErr
\t_, _, _, _, _, _, _, stk.parenHead, _, _, err = lexFrom(src, 0, false, 0, 0, 0, false, false, stk.parenHead[:0], false, false, &out, 0)
\treturn out, err
}`;
  }
  if (tplOnly) {
    return `${idTables}${lexStacks}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, templateStack []int, acc *[]Tok, limit int) (int, bool, []int, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${emitTplOnly}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
lexFail:
\treturn pos, pendingNl, templateStack, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\tvar err *lexErr
\t_, _, stk.templateStack, err = lexFrom(src, 0, false, stk.templateStack[:0], &out, 0)
\treturn out, err
}`;
  }
  if (rxTpl) {
    return `${idTables}${lexStacks}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, templateStack []int, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool, []int, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${rxStateFrom}${emitRxTpl}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
lexFail:
\treturn pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\tvar err *lexErr
\t_, _, _, _, _, _, _, stk.parenHead, _, _, stk.templateStack, err = lexFrom(src, 0, false, 0, 0, 0, false, false, stk.parenHead[:0], false, false, stk.templateStack[:0], &out, 0)
\treturn out, err
}`;
  }
  if (rxOrTpl) {
    return `${idTables}${lexStacks}${lexGoHelpers}${rxModuleConsts}${scans}func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\ttoks := buf[:0]
\tn := len(src)
\tpos := 0
\tpendingNl := false
\t_ = pendingNl
\tvar err *lexErr
${rxState}${tplState}${nlState}${emitFn}${pushTokFn}\tfor pos < n {
${loopBody}
\t}
lexFail:
${rx ? '\tstk.parenHead = parenHead\n' : ''}${tpl ? '\tstk.templateStack = templateStack\n' : ''}\treturn toks, err
}`;
  }
  if (newlineOnly) {
    return `${idTables}${lexStacks}${lexGoHelpers}${scans}func lexFrom(src string, pos int, pendingNl bool, flowDepth int, acc *[]Tok, limit int) (int, bool, int, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${nlStateFrom}${pushTokAccFn}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
lexFail:
\treturn pos, pendingNl, flowDepth, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\t_, _, _, err := lexFrom(src, 0, false, 0, &out, 0)
\treturn out, err
}`;
  }
  return `${idTables}${lexStacks}${lexGoHelpers}${scans}func lexFrom(src string, pos int, pendingNl bool, acc *[]Tok, limit int) (int, bool, *lexErr) {
\tn := len(src)
\tvar err *lexErr
${pushTokAccFn}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
lexFail:
\treturn pos, pendingNl, err
}
func lexAll(src string) ([]Tok, *lexErr) { return lexInto(src, nil, &lexStacks{}) }
// lexInto lexes src into buf[:0], reusing its capacity (a reused builder's token buffer), and
// likewise the stacks in stk.
func lexInto(src string, buf []Tok, stk *lexStacks) ([]Tok, *lexErr) {
\tout := buf[:0]
\t_, _, err := lexFrom(src, 0, false, &out, 0)
\treturn out, err
}`;
}

// The binary operator read at p.pos (t = p.toks[p.pos]): opLid, its token count opN and (withEnd)
// its end offset opEnd. A '>' read counts the tokens it inspected toward maxLook.
function gtOpRead(ids: LexIdPlan, withEnd: boolean): string {
  if (ids.gtComps.length === 0) return withEnd ? `\t\topLid, opN, opEnd := t.Lid, 1, t.End` : `\t\topLid, opN := t.Lid, 1`;
  return `\t\topLid, opN, ${withEnd ? 'opEnd' : '_'} := gtOp(p.toks, p.pos)
\t\tif t.Lid == ${lidOf(ids, '>')} { if e := p.pos + opN + 1; e > p.maxLook { p.maxLook = e } }`;
}
// An entry's extent (EntryMeta.Ext): one past the furthest token its parse examined. A read past
// the current token (secondIn, a composed '>') records into maxLook at once; a peek records only
// peekEnd, one past its token. Between two moves back the position only grows, so the latest peek
// is the furthest since the last move back: back() folds it into maxLook before the position
// returns, and lookEnd() folds in the stretch since. Every move of the position to an earlier
// token goes through back().
// The token cursor: what every recognizer reads and moves (the position, the tokens, the look
// extent, the suppress set and the context in force). Both engine types embed it, so the cursor's
// helpers and every recognizer that runs no building form (Forms.cursorOnly) are printed once, as
// its methods, and called through either engine (Go promotes the embedded methods).
function cursorGo(ir: ParserIR, ids: LexIdPlan): string {
  return `type cursor struct {
\ttoks []Tok
\tpos, maxLook int
\tpeekEnd int // one past the token of the latest peek (see back)
\tsuppressNext, suppressCur uint16 // indices into the grammar's suppress sets (ParserIR.suppressSets; 0 = none)
\tctx uint8 // the [Await]/[Yield] context word in force (bit 1 await, bit 2 yield; see ParserIR's Ctx)
}

func (p *cursor) peek() *Tok {
\tp.peekEnd = p.pos + 1
\tif p.pos < len(p.toks) { return &p.toks[p.pos] }
\treturn nil
}
// back moves the position back to sp (sp <= pos), first folding the abandoned stretch's furthest
// peek into maxLook.
func (p *cursor) back(sp int) { if p.peekEnd > p.maxLook { p.maxLook = p.peekEnd }; p.pos = sp }
// lookEnd: one past the furthest token the current entry examined.
func (p *cursor) lookEnd() int { if p.peekEnd > p.maxLook { return p.peekEnd }; return p.maxLook }
// lookReset starts recording an entry's extent.
func (p *cursor) lookReset() { p.maxLook = 0; p.peekEnd = 0 }
func (p *cursor) ahead(k int, is bool) bool { t := p.peek(); return (t != nil && inTokenSet(k, t)) == is }
// ctxWord: whether the next token is a word the context in force reserves; outside every context it reads nothing.
func (p *cursor) ctxWord() bool { if p.ctx == 0 { return false }; t := p.peek(); return t != nil && inCtxWords(p.ctx, t) }
// secondIn: whether the token after the current one is in tokenSets[k] (a candidate's SECOND guard).
func (p *cursor) secondIn(k int) bool { i := p.pos + 1; if i >= p.maxLook { p.maxLook = i + 1 }; return i < len(p.toks) && inTokenSet(k, &p.toks[i]) }
func (p *cursor) offAt(i int) int { if i < len(p.toks) { return int(p.toks[i].Off) }; return 0 }
func (p *cursor) matchComp(lid uint16) bool {
\tif p.peek() == nil { return false }
\tc, n, _ := gtOp(p.toks, p.pos)
\tif c != lid { return false }
\tif e := p.pos + n + 1; e > p.maxLook { p.maxLook = e }
\tp.pos += n; return true
}
${recognizeHelpersGo('cursor')}${lookFnsR(ir, ids, CURSOR_GO, true)}${sharedFnsR(ir, ids, CURSOR_GO, true)}${ir.rules.filter((r) => ir.forms.cursorOnly.rules.includes(r.name)).map((r) => ruleR(r as RdRule, ids, CURSOR_GO) + '\n').join('')}`;
}
function engineMarkGo(recv: string): string {
  return `// mark: where a construct that may have to undo what it tries starts; ${recv === 'engine' ? 'reset undoes everything since (the position as back does, the scratch list and the arena).' : 'undoGoW undoes everything since.'}
${recv === 'engine'
  ? `func (p *engine) mark() mark { return mark{p.pos, len(p.scratch), len(p.nodes), len(p.kids)} }
func (p *engine) reset(m mark) { p.back(m.pos); p.scratch = p.scratch[:m.sb]; p.nodes = p.nodes[:m.nb]; p.kids = p.kids[:m.kb] }
// nudNone: a NUD that matched nothing, from its commit switch: the state its frame leaves then.
func (p *engine) nudNone() int32 { p.capped = false; p.form = 0; p.tail = false; return -1 }
// nudOk: a committed NUD arm's node n, with the state its frame leaves for it (inlined).
func (p *engine) nudOk(n int32, tail, capped bool) int32 { p.form = 0; p.tail = tail; p.capped = capped; return n }`
  // Written so that it fits Go's inlining budget (cost 77 of 80). A reset method around the
  // builder's Restore cannot (cost 86 and more with every form tried), and a call where the undo
  // was inline would be added work on every failed branch, so the undo stays printed in place.
  : `func (p *${recv}) mark() (m mark) { m.nb, m.kb = p.b.Checkpoint(); m.pos, m.sb = p.pos, len(p.scratch); return }
func (p *${recv}) nudNone() (spanned, bool) { p.capped = false; p.form = 0; p.tail = false; return spanned{}, false }
func (p *${recv}) nudOk(n spanned, tail, capped bool) (spanned, bool) { p.form = 0; p.tail = tail; p.capped = capped; return n, true }`}`;
}
// '>'-led composite operators (LexIdPlan.gtComps): the lexer scans every '>' alone. gtOp reads the
// operator at ts[i]: a lone '>' extends over each adjacent single-character punct token after it
// while the text stays a composite (gtStep: prefix lid × next character lid → composite lid). A
// punct token (kid 0) is the text of its lid, and gtStep names only one-character lids, so no
// length (which is in bytes here, not characters) is compared.
// leafEnd is a leaf's end offset: an operator leaf at a '>' spans the composite read there.
function gtRuntimeGo(ids: LexIdPlan, ar: ArenaIdPlan): string {
  if (ids.gtComps.length === 0) {
    return `func gtOp(ts []Tok, i int) (uint16, int, uint32) { return ts[i].Lid, 1, ts[i].End }
func leafEnd(ts []Tok, ti uint32, tt uint8) uint32 { _ = tt; return ts[ti].End }`;
  }
  const arms = ids.gtComps.map((c) => {
    const a = lidOf(ids, c.slice(0, -1)), b = lidOf(ids, c.slice(-1)), r = lidOf(ids, c);
    if (a === 0 || b === 0 || r === 0) throw new Error(`goTarget: composite ${JSON.stringify(c)} needs lids for its prefix and last character`);
    return `\tcase a == ${a} && b == ${b}: return ${r}`;
  });
  return `func gtStep(a, b uint16) uint16 {
\tswitch {
${arms.join('\n')}
\t}
\treturn 0
}
func gtOp(ts []Tok, i int) (lid uint16, n int, end uint32) {
\tt := &ts[i]
\tlid, n, end = t.Lid, 1, t.End
\tif lid != ${lidOf(ids, '>')} { return }
\tfor j := i + 1; j < len(ts); j++ {
\t\tu := &ts[j]
\t\tif u.Kid != 0 || u.Off != end { break }
\t\tc := gtStep(lid, u.Lid)
\t\tif c == 0 { break }
\t\tlid, n, end = c, n+1, u.End
\t}
\treturn
}
func leafEnd(ts []Tok, ti uint32, tt uint8) uint32 {
\tif tt == ${ttIdOf(ar, '$operator')} && ts[ti].Lid == ${lidOf(ids, '>')} { _, _, e := gtOp(ts, int(ti)); return e }
\treturn ts[ti].End
}`;
}

const stepCond = (s: Step, ids: LexIdPlan, _ar: ArenaIdPlan): string => walkExpr(s, goSteps(ids, '', 'engine', ENGINE_GO));

// ParserIR.shared, one method each: the step, run against the parser's scratch list. It undoes
// nothing: a failed step leaves what it advanced and appended for the construct around its site.
function sharedFns(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return ir.shared.map((s, id) => (ir.forms.buildShared[id] ? `func (p *engine) sub${id}() bool { ${walkStmts(s, goSteps(ids, '', 'engine', ENGINE_GO))} }\n` : '')).join('');
}


// Longest match: the best node so far stays in the arena: nb/kb move past it, so a later
// alternative that does not beat it is truncated away and one that does leaves it unreferenced.
function rdRule(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const fin = `p.finish(${ruleIdOf(ar, r.name)}, sb, p.offAt(save), save)`;
  const open = '\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)';
  return ruleShell(r, ids, {
    ...goRuleBase(r, ids, ''),
    steps: goSteps(ids, '', 'engine', ENGINE_GO),
    fn: (lines) => `func (p *engine) parse${r.name}() int32 {\n${lines.join('\n')}\n}`,
    accept: () => `{ return ${fin} }`,
    open: (clean) => (clean ? '\tsave := p.pos; sb := len(p.scratch)' : open),
    peekOrFail: '\tt := p.peek(); if t == nil { return -1 }',
    fail: (clean) => (clean ? '\treturn -1' : '\tp.back(save); p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]\n\treturn -1'),
    openBest: (d) => `${open}\n\tbest := int32(-1); bestPos := save${biGo(d)}`,
    peekOpt: '\t_ft := p.peek()',
    cand: (d, i, cond) => candGo(d, i, cond, `best = ${fin}; bestPos = p.pos;${markGo(d, i)} nb = len(p.nodes); kb = len(p.kids)`, lostGo),
    closeBest: '\tp.pos = bestPos\n\treturn best',
    commitPeek: '\t_ft := p.peek()',
    commit: (_i, conds, cond, undo, nullable) => commitGo(conds, commitBodyGo(cond, undo ? UNDO_GO : null, nullable, finGo(ruleIdOf(ar, r.name)), (n) => `return ${n}`), 'return -1'),
    commitFail: '{ return -1 }',
  });
}

/** The entry rule with reuse recording (emit-portable entryShell), native engine: EntryMeta per
 *  top-level entry (+ the Node.ext oracle) via parseTopOne (shape A), or per segment (shape B). */
function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.name);
  return entryShell(plan, ids, {
    topCall: (n) => `\treturn p.parse${n}()`,
    topTry: (n) => `\t{ sp := p.pos; n := p.parse${n}(); if n >= 0 { return n }; p.back(sp) }`,
    topFail: '\treturn -1',
    entryA: (topOne) => `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
func (p *engine) parseTopOne() int32 {
${topOne}
}
func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch)
\tlocalE := p.entries[:0]
\tfor {
\t\tsp := p.pos
\t\tp.lookReset()
\t\tn := p.parseTopOne()
\t\tif n < 0 { p.back(sp); break }
\t\text := p.nodes[n].TokEnd
\t\tif l := uint32(p.lookEnd()); l > ext { ext = l }
\t\tp.nodes[n].Ext = ext // CST oracle for validate assert; reuse decisions read p.entries
\t\tlocalE = append(localE, EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), len(p.scratch) - sb, 1})
\t\tp.scratch = append(p.scratch, n)
\t}
\tp.entries = localE
\treturn p.finish(${rid}, sb, p.offAt(save), save)
}`,
    headSeg: (rule) => `func (p *engine) parseHeadSeg(sb int) (EntryMeta, bool) {
\tp.lookReset()
\tbefore := len(p.scratch)
\tp.opt(func() bool { return p.callRule(p.parse${rule}()) })
\tif len(p.scratch) == before { return EntryMeta{}, false }
\tn := p.scratch[before]
\text := p.nodes[n].TokEnd
\tif l := uint32(p.lookEnd()); l > ext { ext = l }
\treturn EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), before - sb, 1}, true
}
`,
    headUse: `\tif m, ok := p.parseHeadSeg(sb); ok { localE = append(localE, m) }
`,
    loopSeg: (kid, rule) => `func (p *engine) parseLoopSeg(sb int) (EntryMeta, bool) {
\tsp := p.pos; before := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\tp.lookReset()
\tif !p.matchTok(${kid}) {
\t\tp.back(sp); p.scratch = p.scratch[:before]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]
\t\treturn EntryMeta{}, false
\t}
\tp.opt(func() bool { return p.callRule(p.parse${rule}()) })
\tleaf := p.scratch[before]
\tvar tokStart, tokEnd uint32
\tvar off, end uint32
\tif leaf < 0 {
\t\tti, _ := decodeLeaf(leaf)
\t\ttokStart = ti
\t\ttokEnd = ti + 1
\t\toff = p.toks[ti].Off
\t\tend = p.toks[ti].End
\t} else {
\t\ttokStart = p.nodes[leaf].TokStart
\t\ttokEnd = p.nodes[leaf].TokEnd
\t\toff = p.nodes[leaf].Offset
\t\tend = p.nodes[leaf].End
\t}
\tcount := len(p.scratch) - before
\tif count > 1 {
\t\tsecond := p.scratch[before+1]
\t\tif second < 0 {
\t\t\tti, _ := decodeLeaf(second)
\t\t\ttokEnd = ti + 1
\t\t\tend = p.toks[ti].End
\t\t} else {
\t\t\ttokEnd = p.nodes[second].TokEnd
\t\t\tend = p.nodes[second].End
\t\t}
\t}
\text := tokEnd
\tif l := uint32(p.lookEnd()); l > ext { ext = l }
\treturn EntryMeta{int(tokStart), int(tokEnd), int(ext), int(off), int(end), before - sb, count}, true
}`,
    entryB: (headSeg, headUse, loopSeg) => `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
${headSeg}${loopSeg}
func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch)
\tlocalE := p.entries[:0]
${headUse}\tfor {
\t\tif m, ok := p.parseLoopSeg(sb); ok { localE = append(localE, m) } else { break }
\t}
\tp.entries = localE
\treturn p.finish(${rid}, sb, p.offAt(save), save)
}`,
  });
}

// The Go spelling of a Pratt rule's shell (emit-portable.ts, prattShell), common to its two
// engines. Every frame is printed in place, not called: Go inlines no function past its budget,
// and a helper over the loop's locals is past it.
const goPrattBase = (r: PrattRule, leftLeaf: (words: string) => string) => {
  const d = r.nudDispatch;
  return {
    ifAll: ifGo,
    kidIs: (k: number) => `t.Kid == ${k}`,
    lidIs: (l: number) => `t.Lid == ${l}`,
    capBelow: (bp: number) => `minBp < ${bp}`,
    beats: (i: number, end: string) => beatsGo(d, end, i),
    leafEnd: 'save+1',
    dispatch: dispatchGoL('t'),
    led: {
      tailOpen: '!tailClosed',
      lbpAbove: (lbp: number) => `${lbp} > minBp`,
      sameLine: '!t.Nl',
      notLeftLeaf: (words: string[]) => leftLeaf(`[]string{${words.map(J).join(', ')}}`),
      notSuppressed: (set: number) => `p.suppressCur != ${set}`,
      ifAll: (parts: string[]) => (parts.length ? `if ${parts.join(' && ')} ` : ''),
    },
    ledSwitch: (cases: { key: number; arms: string[] }[]) => `\t\tswitch t.Lid {
${cases.map((c) => `\t\tcase ${c.key}:\n${c.arms.map((a) => `\t\t\t${a}`).join('\n')}`).join('\n')}
\t\t}`,
    nudPeek: `\tp.capped = false
\tt := p.peek()`,
    nudClose: `\tp.capped = bc
\tp.form = bf
\tp.tail = bt
\tp.pos = bestPos`,
  };
};

function prattRule(r: PrattRule, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  // The native engine. `won` records the node just finished as the best so far and moves nb/kb
  // past it; `lost` drops what the arm built.
  const rid = ruleIdOf(ar, r.name);
  const d = r.nudDispatch;
  const won = (i: number, form: string, tail: boolean, capped: boolean) =>
    `bestPos = p.pos;${markGo(d, i)} bf, bt, bc = ${form}, ${tail}, ${capped}; nb = len(p.nodes); kb = len(p.kids)`;
  const lost = lostGo;
  const fin = `p.finish(${rid}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart))`;
  const B = goPrattBase(r, (ws) => `!_inW(${ws}, p.headLeafText(left))`);
  const fail = '{ return p.nudNone() }';
  const L: PrattLowering = {
    ...B,
    // A committed arm (emit-portable.ts Commit) leaves what the frame's close would: its node, form,
    // tail and capped flag; failing, no node and the frame's empty state.
    commitLeaf: (_i, conds) => commitGo(conds, `{ save := p.pos; sb := len(p.scratch); p.pushLeaf(uint8(t.Kid), uint32(p.pos)); p.pos++; n := p.finish(${rid}, sb, int(t.Off), save); p.form = 0; p.tail = false; return n }`, fail, true),
    commitSeq: (_i, conds, cond, tail, capped, undo, nullable) => commitGo(conds, commitBodyGo(cond, undo ? UNDO_GO : null, nullable, finGo(rid), (n) => `return p.nudOk(${n}, ${tail}, ${capped})`), fail),
    commitPrefix: (_i, conds) => commitGo(conds, `if pbp := pre_${r.name}[t.Lid]; pbp.ok {
\t\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\t\tp.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos)); p.pos++
\t\toperand := p.bp_${r.name}(pbp.rbp)
\t\tif operand >= 0 && pbp.tgt && p.form != 0 { p.back(save); ${lost}; p.capped = false; return -1 }
\t\tif operand >= 0 { p.scratch = append(p.scratch, operand); n := p.finish(${rid}, sb, int(t.Off), save); p.form = pbp.form; p.tail = true; p.capped = false; return n }
\t\tp.back(save); ${lost}
\t}`, fail),
    commitFail: fail,
    nudEnd: '}',
    commitSw: commitSwGo('t'),
    steps: goSteps(ids, '', 'engine', ENGINE_GO),
    nudGuard: (g, keyed) => guardCond(g, 't', '', keyed),
    nudLeaf: (i) => `{ p.pushLeaf(uint8(t.Kid), uint32(p.pos)); p.pos++; best = p.finish(${rid}, sb, int(t.Off), save); ${won(i, '0', false, false)}; p.back(save) }`,
    nudTpl: (i, hole) => `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tnode := p.matchTemplate_${hole}()
\t\tif node >= 0 && ${beatsGo(d, 'p.pos', i)} { p.scratch = append(p.scratch, node); best = p.finish(${rid}, sb, int(p.nodes[node].Offset), int(p.nodes[node].TokStart)); ${won(i, '0', false, false)} } else { ${lost} }
\t\tp.back(save)
\t}`,
    nudSeq: (i, cond, tail, capped) => candGo(d, i, cond, `best = p.finish(${rid}, sb, p.offAt(save), save); ${won(i, '0', tail, capped)}`, lost),
    // An operand that parses but is not the target the operator requires fails the whole Pratt
    // call, whatever another arm matched.
    nudPrefix: (i) => `\tif pbp := pre_${r.name}[t.Lid]; pbp.ok {
\t\tp.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos)); p.pos++
\t\toperand := p.bp_${r.name}(pbp.rbp)
\t\tif operand >= 0 && pbp.tgt && p.form != 0 { p.back(save); ${lost}; p.capped = false; return -1 }
\t\tif operand >= 0 && ${beatsGo(d, 'p.pos', i)} { p.scratch = append(p.scratch, operand); best = p.finish(${rid}, sb, int(t.Off), save); ${won(i, 'pbp.form', true, false)} } else { ${lost} }
\t\tp.back(save)
\t}`,
    ledArm: (_i, cond, form, closes, exit, clean) => `{
\t\t\tledSave := p.pos; sb := len(p.scratch)${clean ? '' : '; nb := len(p.nodes); kb := len(p.kids)'}
\t\t\tp.scratch = append(p.scratch, left)
\t\t\tif ${cond} { left = ${fin}; form = ${form};${closes ? ' tailClosed = true;' : ''} continue LedLoop }
\t\t\tp.back(ledSave); p.scratch = p.scratch[:sb]${clean ? '' : '; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]'}${exit ? '; break LedLoop' : ''}
\t\t}`,
    postfixToks: (kids) => `\t\tswitch t.Kid {
${kids.map((k) => `\t\tcase ${k}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left); p.pushLeaf(uint8(t.Kid), uint32(p.pos)); p.pos++
\t\t\t\tleft = ${fin}; form = 0; continue LedLoop
\t\t\t}`).join('\n')}
\t\t}`,
    postfixTpl: (hole) => `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tnode := p.matchTemplate_${hole}()
\t\t\tif node >= 0 { sb := len(p.scratch); p.scratch = append(p.scratch, left, node); left = ${fin}; form = 0; continue LedLoop }
\t\t}`,
    postfixOp: `\t\tif post := post_${r.name}[t.Lid]; post.ok && !tailClosed && post.lbp > minBp${r.postfixSameLine ? ' && !t.Nl' : ''} {
\t\t\tif post.tgt && form != 0 { return -1 }
\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left); p.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos)); p.pos++; tailClosed = true
\t\t\tleft = ${fin}; form = 1; continue
\t\t}`,
    binary: `${gtOpRead(ids, false)}
\t\tinfo := bin_${r.name}[opLid]
\t\tif !info.ok || info.lbp <= minBp { break }
\t\tif info.tgt && form != 0 || info.noUnary && form == 2 { return -1 }
\t\tledSave := p.pos; sb := len(p.scratch)
\t\tp.scratch = append(p.scratch, left); p.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos))
\t\tp.pos += opN
\t\trhs := p.bp_${r.name}(info.rbp)
\t\tif rhs < 0 { p.back(ledSave); p.scratch = p.scratch[:sb]; break }
\t\tp.scratch = append(p.scratch, rhs)
\t\tleft = ${fin}
\t\tform = 1; tailClosed = true
\t}`,
    entry: `${goPrattOpTables(r, ids)}
func (p *engine) parse${r.name}() int32 {
\tprev := p.suppressCur
\tp.suppressCur = p.suppressNext
\tp.suppressNext = 0
\tr := p.bp_${r.name}(0)
\tp.suppressCur = prev
\treturn r
}`,
    bpOpen: (label) => `func (p *engine) bp_${r.name}(minBp int) int32 {
\tleft := p.nud_${r.name}(minBp)
\tif left < 0 { return -1 }
\tform := p.form
\tif p.capped { return left }
\ttailClosed := p.tail
${label ? 'LedLoop:\n' : ''}\tfor {
\t\tt := p.peek()
\t\tif t == nil { break }`,
    bpClose: `\tp.form = form
\treturn left
}`,
    nudEnter: `func (p *engine) nud_${r.name}(minBp int) int32 {
${B.nudPeek}
\tif t == nil { return -1 }`,
    nudOpen: `\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\tbest := int32(-1); bestPos := save${biGo(d)}; bf, bt, bc := uint8(0), false, false
\t_, _, _ = sb, nb, kb`,
    nudClose: `\t// A sub-parse may leave p.capped set: only a capped arm that won makes THIS node capped.
${B.nudClose}
\treturn best
}`,
  };
  return prattShell(r, ir, ids, L);
}

/** A Pratt rule's operator tables (emit-portable prattOpTables) as arrays indexed by the token's
 *  lid, one entry per literal id (`ok` marks an operator): a bounds-checked load, where a
 *  map[uint16] would hash on every LED iteration and every prefix NUD. */
function goPrattOpTables(r: PrattRule, ids: LexIdPlan): string {
  const ops = prattOpTables(r, ids);
  const bin = ops.bin.map((b) => `${b.lid}: {${b.lbp}, ${b.rbp}, ${b.tgt}, ${b.noUnary}, true}`).join(', ');
  const pre = ops.pre.map((p) => `${p.lid}: {${p.rbp}, ${p.tgt}, ${p.form}, true}`).join(', ');
  const post = ops.post.map((p) => `${p.lid}: {${p.lbp}, ${p.tgt}, true}`).join(', ');
  return `var bin_${r.name} = [${ops.size}]bp{${bin}}
var pre_${r.name} = [${ops.size}]preOp{${pre}}
var post_${r.name} = [${ops.size}]postOp{${post}}`;
}

// The relex of an edit (both Docs). A lexer error in the relex is the text's own (the relexed
// stream equals a fresh lex: relex-family.ts): the text is rejected with no token stream, after
// `clear` empties what the Doc keeps of its tree.
const goEditBody = (clear: string, treeEq: boolean) => `\ttext, toks, relexed, lerr := relexEdits(oldText, oldToks, edits)
\td.text = text
\tif lerr != nil {
\t\td.text = applyEdits(oldText, edits)
${clear}
\t\td.toks = nil
\t\ta := &Align{OldN: len(oldToks)}
\t\tif d.validate { t := true; a.StreamEq = &t${treeEq ? '; a.TreeEq = &t' : ''} }
\t\td.align = a
\t\treturn -1
\t}
\td.toks = toks`;

function docEditBlockGo(ir: ParserIR, shared: SharedAlgorithms): string {
  const topReuse = ir.reuse;
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse.kind === 'B' && topReuse.hasHead);
  const relexFamily = `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.relexFamily(ir)}\n`;
  const reuseFamily = `\n// ---- reuse family: generated from src/reuse-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.reuseFamily(ir)}\n`;
  const editBody = goEditBody('\t\td.root = -1', true);
  const parseFresh = `\td.root = p.parse(d.text, toksFromMeta(d.text, d.toks))`;
  const reuseFns = topReuse ? `
func (p *engine) countLive(id int32) int {
	if id < 0 { return 0 }
	n := 1
	nd := &p.nodes[id]
	for i := uint32(0); i < nd.KidCount; i++ {
		cid := p.kids[nd.KidStart+i]
		if cid >= 0 { n += p.countLive(cid) }
	}
	return n
}
func (p *engine) shouldReclaim(root int32) bool {
	if root < 0 || p.arenaBaseline == 0 { return false }
	live := p.countLive(root)
	lim := p.arenaBaseline
	if live > lim { lim = live }
	return len(p.nodes) > arenaCompactK*lim
}
func (p *engine) shiftSubtree(id int32, byteDelta, tokDelta int) {
	if id < 0 { panic("shiftSubtree on leaf") }
	nd := &p.nodes[id]
	nd.Offset = uint32(int32(nd.Offset) + int32(byteDelta))
	nd.End = uint32(int32(nd.End) + int32(byteDelta))
	nd.TokStart = uint32(int32(nd.TokStart) + int32(tokDelta))
	nd.TokEnd = uint32(int32(nd.TokEnd) + int32(tokDelta))
	nd.Ext = uint32(int32(nd.Ext) + int32(tokDelta))
	for i := uint32(0); i < nd.KidCount; i++ {
		slot := nd.KidStart + i
		cid := p.kids[slot]
		if cid < 0 {
			ti, tt := decodeLeaf(cid)
			p.kids[slot] = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
		} else {
			p.shiftSubtree(cid, byteDelta, tokDelta)
		}
	}
}
${shapeA ? `func (p *engine) assertEntriesVsNodes(oldEntries []EntryMeta, oldRoot int32) {
	old := p.nodes[oldRoot]
	if len(oldEntries) != int(old.KidCount) {
		panic("entry count vs root kids: " + fmt.Sprintf("%d", len(oldEntries)) + " vs " + fmt.Sprintf("%d", int(old.KidCount)))
	}
	for i, e := range oldEntries {
		nd := p.nodes[p.kids[old.KidStart+uint32(i)]]
		if e.TokStart != int(nd.TokStart) { panic("tok_start entry " + fmt.Sprintf("%d", i)) }
		if e.TokEnd != int(nd.TokEnd) { panic("tok_end entry " + fmt.Sprintf("%d", i)) }
		if e.Ext != int(nd.Ext) { panic("ext entry " + fmt.Sprintf("%d", i)) }
		if e.Off != int(nd.Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		if e.End != int(nd.End) { panic("end entry " + fmt.Sprintf("%d", i)) }
	}
}
func (p *engine) tryReuseTop(oldRoot int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 { return -1, 0 }
	if validate { p.assertEntriesVsNodes(oldEntries, oldRoot) }
	old := p.nodes[oldRoot]
	oldKids := make([]int32, old.KidCount)
	for i := uint32(0); i < old.KidCount; i++ { oldKids[i] = p.kids[old.KidStart+i] }
	prefixLen, suffixStart := reuseBounds(oldEntries, prefix, oldN, suffix)
	prefixKids := oldKids[:prefixLen]
	suffixCand := oldKids[suffixStart:]
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	p.src = newText
	p.toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { p.pos = prefixMeta[prefixLen-1].TokEnd } else { p.pos = 0 }
	p.scratch = p.scratch[:0]
	mid := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, int) {
		adopted := suffixCand[adoptFrom:]
		tokDelta := 0
		if len(adopted) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		for _, s := range adopted { p.shiftSubtree(s, byteDelta, tokDelta) }
		children := make([]int32, 0, len(prefixKids)+len(mid)+len(adopted))
		children = append(children, prefixKids...)
		children = append(children, mid...)
		children = append(children, adopted...)
		newEntries := reuseEntries(prefixMeta, midMeta, suffixMeta, adoptFrom, byteDelta, tokDelta)
		off, end, tokStart, tokEnd := reuseSpan(newEntries)
		kidStart := len(p.kids)
		p.kids = append(p.kids, children...)
		p.nodes = append(p.nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		p.entries = newEntries
		p.pos = len(p.toks)
		return int32(len(p.nodes) - 1), len(prefixKids) + len(adopted)
	}
	tryHit := func() (int32, int, bool) {
		if at := reuseAdoptAt(suffixMeta, oldN, suffix, len(p.toks)-p.pos); at >= 0 { r, n := finishHit(at); return r, n, true }
		return -1, 0, false
	}
	passed := func() bool { return reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) }
	if r, n, ok := tryHit(); ok { return r, n }
	if passed() { return -1, 0 }
	for {
		if p.pos >= len(p.toks) {
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		p.lookReset()
		sp := p.pos
		n := p.parseTopOne()
		if n < 0 { p.back(sp); return -1, 0 }
		ext := p.nodes[n].TokEnd
		if l := uint32(p.lookEnd()); l > ext { ext = l }
		p.nodes[n].Ext = ext
		midMeta = append(midMeta, EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), 0, 1})
		mid = append(mid, n)
		if r, rn, ok := tryHit(); ok { return r, rn }
		if passed() { return -1, 0 }
	}
}
` : ''}${shapeB ? `func (p *engine) assertEntriesVsKids(oldEntries []EntryMeta, oldRoot int32) {
	old := p.nodes[oldRoot]
	for i, e := range oldEntries {
		first := p.kids[old.KidStart+uint32(e.KidStart)]
		last := p.kids[old.KidStart+uint32(e.KidStart+e.KidCount-1)]
		if first >= 0 {
			if e.Off != int(p.nodes[first].Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		}
		if last >= 0 {
			if e.End != int(p.nodes[last].End) { panic("end entry " + fmt.Sprintf("%d", i)) }
		}
	}
}
func (p *engine) tryReuseSeg(oldRoot int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 || len(oldEntries) == 0 { return -1, 0 }
	if validate { p.assertEntriesVsKids(oldEntries, oldRoot) }
	old := p.nodes[oldRoot]
	prefixLen, suffixStart := reuseBounds(oldEntries, prefix, oldN, suffix)
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	prefixKids := make([]int32, 0)
	for _, s := range prefixMeta {
		for i := 0; i < s.KidCount; i++ { prefixKids = append(prefixKids, p.kids[old.KidStart+uint32(s.KidStart+i)]) }
	}
	p.src = newText
	p.toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { p.pos = prefixMeta[prefixLen-1].TokEnd } else { p.pos = 0 }
	p.scratch = p.scratch[:0]
	midKids := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, int) {
		adoptedSegs := suffixMeta[adoptFrom:]
		tokDelta := 0
		if len(adoptedSegs) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adoptedKids := make([]int32, 0)
		for _, s := range adoptedSegs {
			for i := 0; i < s.KidCount; i++ {
				id := p.kids[old.KidStart+uint32(s.KidStart+i)]
				if id < 0 {
					ti, tt := decodeLeaf(id)
					id = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
				} else {
					p.shiftSubtree(id, byteDelta, tokDelta)
				}
				adoptedKids = append(adoptedKids, id)
			}
		}
		children := make([]int32, 0, len(prefixKids)+len(midKids)+len(adoptedKids))
		children = append(children, prefixKids...)
		children = append(children, midKids...)
		children = append(children, adoptedKids...)
		newEntries := reuseSegEntries(prefixMeta, midMeta, suffixMeta, adoptFrom, byteDelta, tokDelta)
		off, end, tokStart, tokEnd := reuseSpan(newEntries)
		kidStart := len(p.kids)
		p.kids = append(p.kids, children...)
		p.nodes = append(p.nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		p.entries = newEntries
		p.pos = len(p.toks)
		return int32(len(p.nodes) - 1), prefixLen + len(adoptedSegs)
	}
	tryHit := func() (int32, int, bool) {
		if at := reuseAdoptAt(suffixMeta, oldN, suffix, len(p.toks)-p.pos); at >= 0 { r, n := finishHit(at); return r, n, true }
		return -1, 0, false
	}
	passed := func() bool { return reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) }
	if r, n, ok := tryHit(); ok { return r, n }
	if passed() { return -1, 0 }
	${hasHeadB ? `if prefixLen == 0 {
		sb := len(p.scratch)
		if m, ok := p.parseHeadSeg(sb); ok {
			m.KidStart = 0
			midKids = append(midKids, p.scratch[sb:]...)
			p.scratch = p.scratch[:sb]
			midMeta = append(midMeta, m)
			if r, rn, ok := tryHit(); ok { return r, rn }
			if passed() { return -1, 0 }
		}
	}
	` : ''}for {
		if p.pos >= len(p.toks) {
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		sb := len(p.scratch)
		m, ok := p.parseLoopSeg(sb)
		if !ok {
			if r, n, hit := tryHit(); hit { return r, n }
			return -1, 0
		}
		midKids = append(midKids, p.scratch[sb:]...)
		p.scratch = p.scratch[:sb]
		m.KidStart = 0
		midMeta = append(midMeta, m)
		if r, rn, hit := tryHit(); hit { return r, rn }
		if passed() { return -1, 0 }
	}
}
` : ''}` : '';
  const editParse = topReuse
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\tforceFresh := d.root < 0 || p.shouldReclaim(d.root)
\tif !forceFresh {
\t\toldEntries := append([]EntryMeta(nil), d.entries...)
\t\tif got, n := p.tryReuse${shapeA ? 'Top' : 'Seg'}(d.root, oldEntries, d.text, d.toks, byteDelta, oldN, prefix, suffix, d.validate); got >= 0 {
\t\t\td.root = got
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = n
\t\t} else {
${parseFresh}
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = 0
\t\t}
\t} else {
${parseFresh}
\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\treused = 0
\t}`
    : `\treused := 0
${parseFresh}`;
  const treeEqFn = `
// checkTreeEq compares p's tree for text with a fresh parse on a separate engine.
func (p *engine) checkTreeEq(text string, root int32) bool {
	// Match TS/Rust: incomplete parse (root>=0 but pos!=len) is not a tree.
	rootOk := root >= 0 && p.pos == len(p.toks)
	f := &engine{}
	toks, err := lexAll(text)
	if err != nil { return !rootOk }
	fresh := f.parse(text, toks)
	freshOk := fresh >= 0 && f.pos == len(f.toks)
	if !rootOk || !freshOk { return rootOk == freshOk }
	var s1, s2 strings.Builder
	p.writeJSON(root, &s1)
	f.writeJSON(fresh, &s2)
	return s1.String() == s2.String()
}
`;
  return `type Edit struct { Start, End int; Text string }
// Packed Doc-state token (~16B). kind → Kid+kindStr; text → src[Off:End];
// Nl/Lc/Lb/Hd packed in Flags; Pd/Fd/Td are narrow depths (paren/flow/template).
type alignMeta struct { Off, End int32; Kid, Pd, Fd uint16; Flags, Td uint8 }
func amNl(m alignMeta) bool { return m.Flags&1 != 0 }
func amLc(m alignMeta) bool { return m.Flags&2 != 0 }
func amLb(m alignMeta) bool { return m.Flags&4 != 0 }
func amHd(m alignMeta) bool { return m.Flags&8 != 0 }
func amText(src string, m alignMeta) string { return src[m.Off:m.End] }
func mkAlign(off, end int32, kid uint16, nl bool, fd, pd uint16, lc, lb, hd bool, td uint8) alignMeta {
	var flags uint8
	if nl { flags |= 1 }
	if lc { flags |= 2 }
	if lb { flags |= 4 }
	if hd { flags |= 8 }
	return alignMeta{Off: off, End: end, Kid: kid, Pd: pd, Fd: fd, Flags: flags, Td: td}
}
func shiftAlign(m alignMeta, delta int) alignMeta {
	return alignMeta{Off: m.Off + int32(delta), End: m.End + int32(delta), Kid: m.Kid, Pd: m.Pd, Fd: m.Fd, Flags: m.Flags, Td: m.Td}
}
type Align struct {
	OldN     int   \`json:"oldN"\`
	NewN     int   \`json:"newN"\`
	Prefix   int   \`json:"prefix"\`
	Suffix   int   \`json:"suffix"\`
	Relexed  int   \`json:"relexed"\`
	Reused   int   \`json:"reused"\`
	StreamEq *bool \`json:"streamEq,omitempty"\`
	TreeEq   *bool \`json:"treeEq,omitempty"\`
}
${relexFamily}${reuseFamily}
func toksFromMeta(text string, meta []alignMeta) []Tok {
	t := make([]Tok, len(meta))
	for i, m := range meta {
		tx := amText(text, m)
		t[i] = mkTok(int(m.Off), int(m.End), amNl(m), m.Kid, ${regionKids(ir, buildLexIdPlan(ir)).length ? `func() uint16 { if ${regionKids(ir, buildLexIdPlan(ir)).map((k) => `m.Kid == ${k}`).join(' || ')} { return 0 }; return lidOf(tx) }()` : 'lidOf(tx)'})
	}
	return t
}
${treeEqFn}${reuseFns}
// A Doc owns its tree: its engine (e) keeps the arena, parse stream and reuse metadata across
// edits, and b (the caller's CstBuilder under NewDocWith) is pointed at that tree after each call.
type Doc struct { text string; root int32; toks []alignMeta; align *Align; validate bool; b *CstBuilder; e engine${topReuse ? '; entries []EntryMeta' : ''} }
func (d *Doc) publish() { d.b.Nodes, d.b.Kids, d.b.Toks = d.e.nodes, d.e.kids, d.e.toks }
func NewDoc(src string) *Doc { return newDocCst(src, &CstBuilder{}) }
func newDocCst(src string, b *CstBuilder) *Doc {
	d := &Doc{text: src, b: b}
	defer d.publish()
	var toks []Tok
	var err *lexErr
	d.toks, toks, err = scanMetaToks(src)
	if err != nil { panic(lexError(src, err)) }
	// The arena grows as the parse fills it, as in ParseWith and in every target: a node or kid count
	// estimated from the token count is neither a fit nor a bound (6183a29, PR #126).
	d.e.nodes, d.e.kids = b.Nodes[:0], b.Kids[:0]
	d.root = d.e.parse(src, toks)
${topReuse ? '\td.entries = append([]EntryMeta(nil), d.e.entries...)\n' : ''}\treturn d
}
// CstJSON renders the Doc's current tree ("" when its text does not parse).
func (d *Doc) CstJSON() string {
	if d.root < 0 { return "" }
	var buf strings.Builder
	writeJSONWith(d.e.nodes, d.e.kids, d.e.toks, d.root, &buf)
	return buf.String()
}
func (d *Doc) SetValidate(v bool) { d.validate = v }
func (d *Doc) Text() string { return d.text }
func (d *Doc) Root() int32 { return d.root }
func (d *Doc) Align() *Align { return d.align }
func (d *Doc) Edit(edits []Edit) (ret int32) {
	p := &d.e
	defer d.publish()
	oldText, oldToks := d.text, d.toks
${editBody}
	oldN, newN, prefix, suffix := computeAlignCore(oldText, oldToks, d.text, d.toks)
${editParse}
	a := &Align{OldN: oldN, NewN: newN, Prefix: prefix, Suffix: suffix, Relexed: relexed, Reused: reused}
	if d.validate {
		v := checkStreamEq(d.text, d.toks); a.StreamEq = &v
		t := p.checkTreeEq(d.text, d.root); a.TreeEq = &t
	}
	d.align = a
	ret = d.root
	return
}`;
}

// ─── Builder API (additive parse_with) — second instantiation ────────────────
// Parallel combinators / rules ending in `W`. Existing `parse`/arena/`Doc` above
// are byte-identical to pre-addon emit; this block is appended only.

/** The builder engine's arena checkpoint (Builder.Checkpoint). */
const arenaCkpt = () => 'nb, kb := p.b.Checkpoint()';
/** Move the checkpoint past what was just built (the best alternative so far stays). */
const arenaMark = () => 'nb, kb = p.b.Checkpoint()';
/** Undo to the checkpoint (Builder.Restore). */
const arenaRestore = () => 'p.b.Restore(nb, kb)';

const stepCondW = (s: Step, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string => walkExpr(s, goSteps(ids, 'W', recv, ENGINE_GO_W, ar));
function sharedFnsW(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  return ir.shared.map((s, id) => (ir.forms.buildShared[id] ? `func (p *${recv}) sub${id}W() bool { ${walkStmts(s, goSteps(ids, 'W', recv, ENGINE_GO_W, ar))} }\n` : '')).join('');
}

function rdRuleW(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const fin = `p.finishW(${ruleIdOf(ar, r.name)}, sb, p.offAt(save), save)`;
  const open = `\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt()}`;
  return ruleShell(r, ids, {
    ...goRuleBase(r, ids, 'W'),
    steps: goSteps(ids, 'W', recv, ENGINE_GO_W, ar),
    fn: (lines) => `func (p *${recv}) parse${r.name}W() (spanned, bool) {\n${lines.join('\n')}\n}`,
    accept: () => `{ return ${fin}, true }`,
    open: (clean) => (clean ? '\tsave := p.pos; sb := len(p.scratch)' : open),
    peekOrFail: '\tt := p.peek(); if t == nil { return spanned{}, false }',
    fail: (clean) => (clean ? '\treturn spanned{}, false' : `\tp.back(save); p.scratch = p.scratch[:sb]; ${arenaRestore()}\n\treturn spanned{}, false`),
    openBest: (d) => `${open}\n\tvar best spanned; found := false; bestPos := save${biGo(d)}`,
    peekOpt: '\t_ft := p.peek()',
    cand: (d, i, cond) => candGo(d, i, cond, `best = ${fin}; found = true; bestPos = p.pos;${markGo(d, i)} ${arenaMark()}`, lostGoW(recv)),
    closeBest: '\tp.pos = bestPos\n\treturn best, found',
    commitPeek: '\t_ft := p.peek()',
    commit: (_i, conds, cond, undo, nullable) => commitGo(conds, commitBodyGo(cond, undo ? undoGoWc(recv) : null, nullable, (sb, save) => `p.finishW(${ruleIdOf(ar, r.name)}, ${sb}, p.offAt(${save}), ${save})`, (n) => `return ${n}, true`), 'return spanned{}, false'),
    commitFail: '{ return spanned{}, false }',
  });
}

/** The entry rule with reuse recording (emit-portable entryShell), builder engine. Engine-side
 *  EntryMeta (R2): consumer handles are never mutated; a span comes from spanned + SpanOf. */
function rdEntryWithReuseW(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.name);
  const close = `\tp.entryHs = append(p.entryHs[:0], p.scratch[sb:]...) // DocWith copies it out (parseWithMetaW)
\tp.entries = localE
\treturn p.finishW(${rid}, sb, p.offAt(save), save), true
}`;
  return entryShell(plan, ids, {
    topCall: (n) => `\treturn p.parse${n}W()`,
    topTry: (n) => `\t{ sp := p.pos; fr, ok := p.parse${n}W(); if ok { return fr, true }; p.back(sp) }`,
    topFail: '\treturn spanned{}, false',
    entryA: (topOne) => `func (p *${recv}) parseTopOneW() (spanned, bool) {
${topOne}
}
func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch)
\tlocalE := p.entries[:0] // a reused builder's Workspace list (ParseWith), else nil
\tfor {
\t\tsp := p.pos
\t\tp.lookReset()
\t\tfr, ok := p.parseTopOneW()
\t\tif !ok { p.back(sp); break }
\t\ttokEnd := p.pos
\t\text := tokEnd
\t\tif l := p.lookEnd(); l > ext { ext = l }
\t\tend := int(fr.off)
\t\tif fr.present {
\t\t\t_, e1 := p.b.SpanOf(fr.h, p.toks)
\t\t\tend = int(e1)
\t\t\tlocalE = append(localE, EntryMeta{int(fr.tokStart), tokEnd, ext, int(fr.off), end, len(p.scratch) - sb, 1})
\t\t\tp.scratch = append(p.scratch, fr.h)
\t\t}
\t}
${close}`,
    headSeg: (rule) => `func (p *${recv}) parseHeadSegW(sb int) (EntryMeta, bool) {
\tp.lookReset()
\tbefore := len(p.scratch)
\ttokStart := p.pos
\tp.optW(func() bool { return p.callRuleW(p.parse${rule}W()) })
\tif len(p.scratch) == before { return EntryMeta{}, false }
\th := p.scratch[before]
\to0, e1 := p.b.SpanOf(h, p.toks)
\ttokEnd := p.pos
\text := tokEnd
\tif l := p.lookEnd(); l > ext { ext = l }
\treturn EntryMeta{tokStart, tokEnd, ext, int(o0), int(e1), before - sb, 1}, true
}
`,
    headUse: `\tif m, ok := p.parseHeadSegW(sb); ok { localE = append(localE, m) }
`,
    loopSeg: (kid, rule) => `func (p *${recv}) parseLoopSegW(sb int) (EntryMeta, bool) {
\tsp := p.pos; before := len(p.scratch); ${arenaCkpt()}
\tp.lookReset()
\tif !(p.tokW(${kid}) && p.takeW(${kid})) {
\t\tp.back(sp); p.scratch = p.scratch[:before]; ${arenaRestore()}
\t\treturn EntryMeta{}, false
\t}
\tp.optW(func() bool { return p.callRuleW(p.parse${rule}W()) })
\tcount := len(p.scratch) - before
\tif count == 0 { return EntryMeta{}, false }
\tleaf := p.scratch[before]
\to0, e1 := p.b.SpanOf(leaf, p.toks)
\tend := e1
\tif count > 1 {
\t\t_, e2 := p.b.SpanOf(p.scratch[before+1], p.toks)
\t\tend = e2
\t}
\ttokStart := sp
\ttokEnd := p.pos
\text := tokEnd
\tif l := p.lookEnd(); l > ext { ext = l }
\treturn EntryMeta{tokStart, tokEnd, ext, int(o0), int(end), before - sb, count}, true
}`,
    entryB: (headSeg, headUse, loopSeg) => `${headSeg}${loopSeg}
func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch)
\tlocalE := p.entries[:0] // a reused builder's Workspace list (ParseWith), else nil
${headUse}\tfor {
\t\tm, ok := p.parseLoopSegW(sb)
\t\tif !ok { break }
\t\tlocalE = append(localE, m)
\t}
${close}`,
  });
}

function prattRuleW(r: PrattRule, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  // The builder engine: as prattRule, over spanned handles and the builder's checkpoint.
  const rid = ruleIdOf(ar, r.name);
  const d = r.nudDispatch;
  const won = (i: number, form: string, tail: boolean, capped: boolean) =>
    `found = true; bestPos = p.pos;${markGo(d, i)} bf, bt, bc = ${form}, ${tail}, ${capped}; ${arenaMark()}`;
  const lost = lostGoW(recv);
  const fin = `p.finishW(${rid}, sb, int(left.off), int(left.tokStart))`;
  const B = goPrattBase(r, (ws) => `!p.nllBlockedW(${ws}, left)`);
  const fail = '{ return p.nudNone() }';
  const L: PrattLowering = {
    ...B,
    commitLeaf: (_i, conds) => commitGo(conds, `{ save := p.pos; sb := len(p.scratch); p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++; n := p.finishW(${rid}, sb, int(t.Off), save); p.form = 0; p.tail = false; return n, true }`, fail, true),
    commitSeq: (_i, conds, cond, tail, capped, undo, nullable) => commitGo(conds, commitBodyGo(cond, undo ? undoGoWc(recv) : null, nullable, (sb, save) => `p.finishW(${rid}, ${sb}, p.offAt(${save}), ${save})`, (n) => `return p.nudOk(${n}, ${tail}, ${capped})`), fail),
    commitPrefix: (_i, conds) => commitGo(conds, `if pbp := pre_${r.name}[t.Lid]; pbp.ok {
\t\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt()}
\t\tp.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++
\t\toperand, ook := p.bpW_${r.name}(pbp.rbp)
\t\tif ook && pbp.tgt && p.form != 0 { p.back(save); ${lost}; p.capped = false; return spanned{}, false }
\t\tif ook { if operand.present { p.scratch = append(p.scratch, operand.h) }; n := p.finishW(${rid}, sb, p.offAt(save), save); p.form = pbp.form; p.tail = true; p.capped = false; return n, true }
\t\tp.back(save); ${lost}
\t}`, fail),
    commitFail: fail,
    nudEnd: '}',
    commitSw: commitSwGo('t'),
    steps: goSteps(ids, 'W', recv, ENGINE_GO_W, ar),
    nudGuard: (g, keyed) => guardCond(g, 't', 'W', keyed),
    nudLeaf: (i) => `{ p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++; best = p.finishW(${rid}, sb, int(t.Off), save); ${won(i, '0', false, false)}; p.back(save) }`,
    nudTpl: (i, hole) => `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tn, ok := p.matchTemplateW_${hole}()
\t\tif ok && ${beatsGo(d, 'p.pos', i)} { if n.present { p.scratch = append(p.scratch, n.h) }; best = p.finishW(${rid}, sb, int(n.off), int(n.tokStart)); ${won(i, '0', false, false)} } else { ${lost} }
\t\tp.back(save)
\t}`,
    nudSeq: (i, cond, tail, capped) => candGo(d, i, cond, `best = p.finishW(${rid}, sb, p.offAt(save), save); ${won(i, '0', tail, capped)}`, lost),
    nudPrefix: (i) => `\tif pbp := pre_${r.name}[t.Lid]; pbp.ok {
\t\tp.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++
\t\toperand, ook := p.bpW_${r.name}(pbp.rbp)
\t\tif ook && pbp.tgt && p.form != 0 { p.back(save); ${lost}; p.capped = false; return spanned{}, false }
\t\tif ook && ${beatsGo(d, 'p.pos', i)} { if operand.present { p.scratch = append(p.scratch, operand.h) }; best = p.finishW(${rid}, sb, p.offAt(save), save); ${won(i, 'pbp.form', true, false)} } else { ${lost} }
\t\tp.back(save)
\t}`,
    ledArm: (_i, cond, form, closes, exit, clean) => `{
\t\t\tledSave := p.pos; sb := len(p.scratch)${clean ? '' : `; ${arenaCkpt()}`}
\t\t\tp.scratch = append(p.scratch, left.h)
\t\t\tif ${cond} { left = ${fin}; form = ${form};${closes ? ' tailClosed = true;' : ''} continue LedLoop }
\t\t\tp.back(ledSave); p.scratch = p.scratch[:sb]${clean ? '' : `; ${arenaRestore()}`}${exit ? '; break LedLoop' : ''}
\t\t}`,
    postfixToks: (kids) => `\t\tswitch t.Kid {
${kids.map((k) => `\t\tcase ${k}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++
\t\t\t\tleft = ${fin}; form = 0; continue LedLoop
\t\t\t}`).join('\n')}
\t\t}`,
    postfixTpl: (hole) => `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tif n, ok := p.matchTemplateW_${hole}(); ok {
\t\t\t\tsb := len(p.scratch)
\t\t\t\tif left.present { p.scratch = append(p.scratch, left.h) }
\t\t\t\tif n.present { p.scratch = append(p.scratch, n.h) }
\t\t\t\tleft = ${fin}; form = 0; continue LedLoop
\t\t\t}
\t\t}`,
    postfixOp: `\t\tif post := post_${r.name}[t.Lid]; post.ok && !tailClosed && post.lbp > minBp${r.postfixSameLine ? ' && !t.Nl' : ''} {
\t\t\tif post.tgt && form != 0 { return spanned{}, false }
\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++; tailClosed = true
\t\t\tleft = ${fin}; form = 1; continue
\t\t}`,
    binary: `${gtOpRead(ids, true)}
\t\tinfo := bin_${r.name}[opLid]
\t\tif !info.ok || info.lbp <= minBp { break }
\t\tif info.tgt && form != 0 || info.noUnary && form == 2 { return spanned{}, false }
\t\tledSave := p.pos; sb := len(p.scratch)
\t\tp.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, opEnd)
\t\tp.pos += opN
\t\trhs, rok := p.bpW_${r.name}(info.rbp)
\t\tif !rok { p.back(ledSave); p.scratch = p.scratch[:sb]; break }
\t\tif rhs.present { p.scratch = append(p.scratch, rhs.h) }
\t\tleft = ${fin}
\t\tform = 1; tailClosed = true
\t}`,
    entry: `func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tprev := p.suppressCur
\tp.suppressCur = p.suppressNext
\tp.suppressNext = 0
\tr, ok := p.bpW_${r.name}(0)
\tp.suppressCur = prev
\treturn r, ok
}`,
    bpOpen: (label) => `func (p *${recv}) bpW_${r.name}(minBp int) (spanned, bool) {
\tleft, ok := p.nudW_${r.name}(minBp)
\tif !ok { return spanned{}, false }
\tform := p.form
\tif p.capped { return left, true }
\ttailClosed := p.tail
${label ? 'LedLoop:\n' : ''}\tfor {
\t\tt := p.peek()
\t\tif t == nil { break }`,
    bpClose: `\tp.form = form
\treturn left, true
}`,
    nudEnter: `func (p *${recv}) nudW_${r.name}(minBp int) (spanned, bool) {
${B.nudPeek}
\tif t == nil { return spanned{}, false }`,
    nudOpen: `\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt()}
\tvar best spanned; found := false; bestPos := save${biGo(d)}; bf, bt, bc := uint8(0), false, false
\t_, _, _ = sb, nb, kb`,
    nudClose: `${B.nudClose}
\treturn best, found
}`,
  };
  return prattShell(r, ir, ids, L);
}

function emitParserMethodsW(recv: string, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const reuse = ir.reuse;
  // entryHs: flat entry-level handles (shape-A kids / shape-B root kids), snapshotted
  // before finishW consumes scratch — DocWith reuse reads this, never Builder.Nodes.
  const entriesField = reuse ? '\n\tentries []EntryMeta\n\tentryHs []int32' : '';
  if (recv !== ENGINE_GO_W.recv) throw new Error(`goTarget: the builder engine is ${ENGINE_GO_W.recv}`);
  const ruleFnsW = [...ir.rules.filter((r) => ir.forms.buildRules.includes(r.name)).map((r) => {
    if (r.kind === 'pratt') return prattRuleW(r, ir, ids, ar, recv);
    if (reuse && r.name === ir.entry) return rdEntryWithReuseW(r, reuse, ids, ar, recv);
    return rdRuleW(r, ids, ar, recv);
  }), ...ir.rules.filter((r) => ir.forms.recognizeRules.includes(r.name) && !ir.forms.cursorOnly.rules.includes(r.name)).map((r) => ruleR(r, ids, ENGINE_GO_W))].join('\n\n');
  // One template matcher per hole rule (tplHoleRules): the hole is parsed by the rule the
  // matching reference declares, called directly.
  const matchTemplateW = tplHoleRules(ir).map((hole) => `func (p *${recv}) matchTemplateW_${hole}() (spanned, bool) {
\tt := p.peek()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return spanned{}, false }
\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt()}
\tp.pushLeafW(${ttIdOf(ar, '$templateHead')}, uint32(p.pos), t.Off, t.End); p.pos++
\tfor {
\t\texpr, ok := p.parse${hole}W()
\t\tif !ok { p.back(save); p.scratch = p.scratch[:sb]; ${arenaRestore()}; return spanned{}, false }
\t\tif expr.present { p.scratch = append(p.scratch, expr.h) }
\t\tnext := p.peek()
\t\tif next == nil { p.back(save); p.scratch = p.scratch[:sb]; ${arenaRestore()}; return spanned{}, false }
\t\tif next.Kid == ${kidOf(ids, '$templateMiddle')} { p.pushLeafW(${ttIdOf(ar, '$templateMiddle')}, uint32(p.pos), next.Off, next.End); p.pos++; continue }
\t\tif next.Kid == ${kidOf(ids, '$templateTail')} { p.pushLeafW(${ttIdOf(ar, '$templateTail')}, uint32(p.pos), next.Off, next.End); p.pos++; break }
\t\tp.back(save); p.scratch = p.scratch[:sb]; ${arenaRestore()}; return spanned{}, false
\t}
\treturn p.finishW(${ruleIdOf(ar, '$template')}, sb, p.offAt(save), save), true
}
`).join('');
  const pushLeafW = `func (p *${recv}) pushLeafW(ttId uint16, tokIdx, off, end uint32) {
\tif !p.drops[uint8(ttId)] { _ = p.b.Leaf(&p.scratch, ttId, tokIdx, off, end) }
}`;
  const finishW = `func (p *${recv}) finishW(ruleId uint16, sb, fallbackOff, tokStart int) spanned {
\th, off, present := p.b.Finish(&p.scratch, sb, ruleId, uint32(fallbackOff), uint32(tokStart), uint32(p.pos), p.toks)
\treturn spanned{h: h, off: off, tokStart: uint32(tokStart), present: present}
}`;
  const headLeafTextW = `func (p *${recv}) headLeafTextW(f spanned) string {
\tif !f.present { return "" }
\ta, b := p.b.HeadSpan(f.h, p.toks)
\tif a <= b && int(b) <= len(p.src) { return p.src[a:b] }
\treturn ""
}`;
  const structFields = `\tcursor
\tcapped bool
\tform uint8 // assignment-target form of the node the last nud_/bp_ call returned
\ttail bool  // whether the node the last nud_ call returned closes the access tail
\tsrc string
\tb Builder
\tdrops [256]bool // the leaf types b never keeps (dropsOf): such a leaf is not offered
\tscratch []int32${entriesField}`;
  return `type ${recv} struct {
${structFields}
}

${engineMarkGo(recv)}
${pushLeafW}
${finishW}
${headLeafTextW}
func (p *${recv}) nllBlockedW(words []string, left spanned) bool {
\th := p.headLeafTextW(left)
\tfor _, w := range words { if w == h { return true } }
\treturn false
}
// litW / tokW test the token in place as the direct engine's matchLit / matchTok do (the probe is a
// peek: peekEnd); takeW consumes the token they accepted and hands its leaf to the builder. A step
// spells the two in a row (\`p.litW(l) && p.takeW(tt)\`, tt the literal's litTt, a constant):
// Go's inliner charges a call 57 of its budget of 80, so one function holding both the test and
// the builder call is not inlined (cost 132), while each half is (litW 30, takeW 74). The builder call itself is out of line
// (offerW): spelled inside takeW, the call's arguments put takeW over the budget (104), and a
// leaf the builder drops (p.drops) makes no call at all.
func (p *${recv}) litW(lid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1
\treturn i < len(p.toks) && p.toks[i].Lid == lid
}
func (p *${recv}) tokW(kid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1
\treturn i < len(p.toks) && p.toks[i].Kid == kid
}
func (p *${recv}) takeW(tt uint16) bool {
\tif !p.drops[uint8(tt)] { p.offerW(tt) }
\tp.pos++
\treturn true
}
func (p *${recv}) offerW(tt uint16) { i := p.pos; t := &p.toks[i]; p.b.Leaf(&p.scratch, tt, uint32(i), t.Off, t.End) }
// callRuleW pushes the node of a rule call that matched (the call's two results, as callRule takes
// the direct engine's: a direct call, not one through a method value).
func (p *${recv}) callRuleW(fr spanned, ok bool) bool {
\tif !ok { return false }
\tif fr.present { p.scratch = append(p.scratch, fr.h) }
\treturn true
}
func (p *${recv}) starW(once func() bool) bool {
\tfor {
\t\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt()}
\t\tif !once() { p.back(sp); p.scratch = p.scratch[:sb]; ${arenaRestore()}; break }
\t}
\treturn true
}
func (p *${recv}) starInW(k int, once func() bool) bool {
	for p.ahead(k, true) {
		sp := p.pos; sb := len(p.scratch); ${arenaCkpt()}
		if !once() { p.back(sp); p.scratch = p.scratch[:sb]; ${arenaRestore()}; break }
	}
	return true
}
// A clean body (Step.clean) leaves no trace when it fails: no mark, nothing to undo. Kept out of
// line (go:noinline), as the marked forms already are by Go's inline budget: inlined, these small
// helpers and their closures grew the frames of the large rule functions, and every call of those
// paid for it on paths that never run the helper (dense-semi: parseStmtW / parseDeclW +7.5
// instructions per call, Go builder Ir +5.3%).
//go:noinline
func (p *${recv}) starCW(once func() bool) bool {
\tfor once() {}
\treturn true
}
//go:noinline
func (p *${recv}) starInCW(k int, once func() bool) bool {
\tfor p.ahead(k, true) && once() {}
\treturn true
}
//go:noinline
func (p *${recv}) optCW(body func() bool) bool { body(); return true }
//go:noinline
func (p *${recv}) sepByCW(elem func() bool, delim uint16) bool {
\tif elem() { for p.litW(delim) && p.takeW(litTt(delim)) && elem() {} }
\treturn true
}
func (p *${recv}) optW(body func() bool) bool {
\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt()}
\tif !body() { p.back(sp); p.scratch = p.scratch[:sb]; ${arenaRestore()} }
\treturn true
}
func (p *${recv}) sepByW(elem func() bool, delim uint16) bool {
\tsp0 := p.pos; sb0 := len(p.scratch); ${arenaCkpt().replace('nb, kb', 'nb0, kb0')}
\tif !elem() { p.back(sp0); p.scratch = p.scratch[:sb0]; ${arenaRestore().replace('nb', 'nb0').replace('kb', 'kb0')}; return true }
\tfor {
\t\tif !(p.litW(delim) && p.takeW(litTt(delim))) { break } // a failed delimiter match changes nothing: no mark before it
\t\tsp2 := p.pos; sb2 := len(p.scratch); ${arenaCkpt().replace('nb, kb', 'nb2, kb2')}
\t\tif !elem() { p.back(sp2); p.scratch = p.scratch[:sb2]; ${arenaRestore().replace('nb', 'nb2').replace('kb', 'kb2')}; break }
\t}
\treturn true
}
func (p *${recv}) altLitW(lids []uint16) bool {
\tfor _, lid := range lids { if p.litW(lid) && p.takeW(litTt(lid)) { return true } }
\treturn false
}

// found: whether a builder-engine parse matched (its node dropped: a recognize form).
func parsedW(_ spanned, ok bool) bool { return ok }

${matchTemplateW}${lookFnsR(ir, ids, ENGINE_GO_W, false)}${sharedFnsW(ir, ids, ar, recv)}${sharedFnsR(ir, ids, ENGINE_GO_W, false)}${ruleFnsW}
`;
}

function emitDocWithGo(
  ir: ParserIR,
  entryRid: number,
  shapeA: boolean,
  shapeB: boolean,
  hasHeadB: boolean,
  topReuse: boolean,
  initToks: string,
): string {
  const entry = ir.entry;
  const entriesFields = topReuse
    ? `\n\tentries []EntryMeta\n\tentryHs []int32`
    : '';

  const shiftHandleFn = `
// shiftHandle mutates a consumer builder arena (or returns a shifted leaf handle).
func shiftHandle(nodes []Node, kids *[]int32, h int32, byteDelta, tokDelta int) int32 {
	if h < 0 {
		ti, tt := decodeLeaf(h)
		return encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
	}
	nd := &nodes[h]
	nd.Offset = uint32(int32(nd.Offset) + int32(byteDelta))
	nd.End = uint32(int32(nd.End) + int32(byteDelta))
	nd.TokStart = uint32(int32(nd.TokStart) + int32(tokDelta))
	nd.TokEnd = uint32(int32(nd.TokEnd) + int32(tokDelta))
	nd.Ext = uint32(int32(nd.Ext) + int32(tokDelta))
	for i := uint32(0); i < nd.KidCount; i++ {
		slot := nd.KidStart + i
		cid := (*kids)[slot]
		if cid < 0 {
			ti, tt := decodeLeaf(cid)
			(*kids)[slot] = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
		} else {
			shiftHandle(nodes, kids, cid, byteDelta, tokDelta)
		}
	}
	return h
}
func (b *CstBuilder) Shift(h int32, byteDelta, tokDelta int) int32 {
	return shiftHandle(b.Nodes, &b.Kids, h, byteDelta, tokDelta)
}
`;

  // EntryMeta is part of parseWithMetaW's signature always; reuse paths define it via
  // rdEntryWithReuse{A,B}. Non-reuse grammars (e.g. toy) still emit DocWith and need the type.
  const entryMetaType = topReuse ? '' : `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
`;

  const parseWithMetaW = `
${entryMetaType}func parseWithMetaW(text string, meta []alignMeta, b Builder) (h int32, entries []EntryMeta, entryHs []int32, ok bool) {
	p := &parserW{cursor: cursor{toks: toksFromMeta(text, meta)}, src: text, b: b, drops: dropsOf(b), scratch: nil}
	fr, pok := p.parse${entry}W()
	recordToks(b, p.toks)
	if !pok || p.pos != len(p.toks) {
		return 0, nil, nil, false
	}
	if !fr.present { panic(errNoRoot) }
${topReuse
    ? `\treturn fr.h, append([]EntryMeta(nil), p.entries...), append([]int32(nil), p.entryHs...), true`
    : `\treturn fr.h, nil, nil, true`}
}
`;

  const tryReuseTopW = shapeA
    ? `
func tryReuseTopW(b Builder, sh Shifter, oldHs []int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int) (root int32, newEntries []EntryMeta, newHs []int32, reused int, ok bool) {
	prefixLen, suffixStart := reuseBounds(oldEntries, prefix, oldN, suffix)
	prefixKids := append([]int32(nil), oldHs[:prefixLen]...)
	suffixCand := append([]int32(nil), oldHs[suffixStart:]...)
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	p := &parserW{cursor: cursor{toks: toksFromMeta(newText, newMeta)}, src: newText, b: b, drops: dropsOf(b), scratch: nil}
	if prefixLen > 0 {
		p.pos = prefixMeta[prefixLen-1].TokEnd
	} else {
		p.pos = 0
	}
	mid := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, []EntryMeta, []int32, int, bool) {
		tokDelta := 0
		if adoptFrom < len(suffixMeta) {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adopted := make([]int32, 0, len(suffixCand)-adoptFrom)
		for _, s := range suffixCand[adoptFrom:] {
			adopted = append(adopted, sh.Shift(s, byteDelta, tokDelta))
		}
		children := make([]int32, 0, len(prefixKids)+len(mid)+len(adopted))
		children = append(children, prefixKids...)
		children = append(children, mid...)
		children = append(children, adopted...)
		outE := reuseEntries(prefixMeta, midMeta, suffixMeta, adoptFrom, byteDelta, tokDelta)
		off, end, tokStart, tokEnd := reuseSpan(outE)
		scratch := append([]int32(nil), children...)
		b.Node(&scratch, 0, ${entryRid}, uint32(off), uint32(end), uint32(tokStart), uint32(tokEnd))
		if len(scratch) != 1 {
			return 0, nil, nil, 0, false
		}
		recordToks(b, p.toks)
		return scratch[0], outE, children, len(prefixKids) + len(adopted), true
	}
	tryHit := func() (int32, []EntryMeta, []int32, int, bool) {
		if at := reuseAdoptAt(suffixMeta, oldN, suffix, len(p.toks)-p.pos); at >= 0 {
			return finishHit(at)
		}
		return 0, nil, nil, 0, false
	}
	if r, e, hs, n, hit := tryHit(); hit {
		return r, e, hs, n, true
	}
	if reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) {
		return 0, nil, nil, 0, false
	}
	for {
		if p.pos >= len(p.toks) {
			if r, e, hs, n, hit := tryHit(); hit {
				return r, e, hs, n, true
			}
			return 0, nil, nil, 0, false
		}
		p.lookReset()
		sp := p.pos
		fr, pok := p.parseTopOneW()
		if !pok {
			p.back(sp)
			return 0, nil, nil, 0, false
		}
		tokEnd := p.pos
		ext := tokEnd
		if l := p.lookEnd(); l > ext {
			ext = l
		}
		end := int(fr.off)
		if fr.present {
			_, e1 := b.SpanOf(fr.h, p.toks)
			end = int(e1)
		}
		midMeta = append(midMeta, EntryMeta{int(fr.tokStart), tokEnd, ext, int(fr.off), end, 0, 1})
		mid = append(mid, fr.h)
		if r, e, hs, n, hit := tryHit(); hit {
			return r, e, hs, n, true
		}
		if reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) {
			return 0, nil, nil, 0, false
		}
	}
}
`
    : '';

  const tryReuseSegW = shapeB
    ? `
func tryReuseSegW(b Builder, sh Shifter, oldRootHs []int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int) (root int32, newEntries []EntryMeta, newHs []int32, reused int, ok bool) {
	if len(oldEntries) == 0 {
		return 0, nil, nil, 0, false
	}
	prefixLen, suffixStart := reuseBounds(oldEntries, prefix, oldN, suffix)
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	prefixKids := make([]int32, 0)
	for _, s := range prefixMeta {
		for i := 0; i < s.KidCount; i++ {
			prefixKids = append(prefixKids, oldRootHs[s.KidStart+i])
		}
	}
	p := &parserW{cursor: cursor{toks: toksFromMeta(newText, newMeta)}, src: newText, b: b, drops: dropsOf(b), scratch: nil}
	if prefixLen > 0 {
		p.pos = prefixMeta[prefixLen-1].TokEnd
	} else {
		p.pos = 0
	}
	midKids := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, []EntryMeta, []int32, int, bool) {
		adoptedSegs := suffixMeta[adoptFrom:]
		tokDelta := 0
		if len(adoptedSegs) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adoptedKids := make([]int32, 0)
		for _, s := range adoptedSegs {
			for i := 0; i < s.KidCount; i++ {
				adoptedKids = append(adoptedKids, sh.Shift(oldRootHs[s.KidStart+i], byteDelta, tokDelta))
			}
		}
		children := make([]int32, 0, len(prefixKids)+len(midKids)+len(adoptedKids))
		children = append(children, prefixKids...)
		children = append(children, midKids...)
		children = append(children, adoptedKids...)
		outE := reuseSegEntries(prefixMeta, midMeta, suffixMeta, adoptFrom, byteDelta, tokDelta)
		off, end, tokStart, tokEnd := reuseSpan(outE)
		scratch := append([]int32(nil), children...)
		b.Node(&scratch, 0, ${entryRid}, uint32(off), uint32(end), uint32(tokStart), uint32(tokEnd))
		if len(scratch) != 1 {
			return 0, nil, nil, 0, false
		}
		recordToks(b, p.toks)
		return scratch[0], outE, children, prefixLen + len(adoptedSegs), true
	}
	tryHit := func() (int32, []EntryMeta, []int32, int, bool) {
		if at := reuseAdoptAt(suffixMeta, oldN, suffix, len(p.toks)-p.pos); at >= 0 {
			return finishHit(at)
		}
		return 0, nil, nil, 0, false
	}
	if r, e, hs, n, hit := tryHit(); hit {
		return r, e, hs, n, true
	}
	if reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) {
		return 0, nil, nil, 0, false
	}
	${hasHeadB
    ? `if prefixLen == 0 {
		sb := len(p.scratch)
		if m, pok := p.parseHeadSegW(sb); pok {
			midKids = append(midKids, p.scratch[sb:]...)
			p.scratch = p.scratch[:sb]
			m.KidStart = 0
			m.KidCount = len(midKids)
			midMeta = append(midMeta, m)
			if r, e, hs, n, hit := tryHit(); hit {
				return r, e, hs, n, true
			}
			if reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) {
				return 0, nil, nil, 0, false
			}
		}
	}
`
    : ''}for {
		if p.pos >= len(p.toks) {
			if r, e, hs, n, hit := tryHit(); hit {
				return r, e, hs, n, true
			}
			return 0, nil, nil, 0, false
		}
		sb := len(p.scratch)
		m, pok := p.parseLoopSegW(sb)
		if !pok {
			if r, e, hs, n, hit := tryHit(); hit {
				return r, e, hs, n, true
			}
			return 0, nil, nil, 0, false
		}
		midKids = append(midKids, p.scratch[sb:]...)
		p.scratch = p.scratch[:sb]
		m.KidStart = 0
		midMeta = append(midMeta, m)
		if r, e, hs, n, hit := tryHit(); hit {
			return r, e, hs, n, true
		}
		if reuseGaveUp(suffixMeta, oldN, len(p.toks)-p.pos) {
			return 0, nil, nil, 0, false
		}
	}
}
`
    : '';

  const editReuse = topReuse
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\t_, hasShift := d.b.(Shifter)
\tforceFresh := !hasShift || d.root < 0${shapeB ? ' || len(d.entries) == 0' : ''}
\tif !forceFresh {
\t\tsh := d.b.(Shifter)
\t\tif got, ne, nhs, n, hit := tryReuse${shapeA ? 'Top' : 'Seg'}W(d.b, sh, d.entryHs, d.entries, d.text, d.toks, byteDelta, oldN, prefix, suffix); hit {
\t\t\td.root = got
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t\treused = n
\t\t} else {
\t\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\t\tif ok {
\t\t\t\td.root = h
\t\t\t\td.entries = ne
\t\t\t\td.entryHs = nhs
\t\t\t} else {
\t\t\t\td.root = -1
\t\t\t\td.entries = nil
\t\t\t\td.entryHs = nil
\t\t\t}
\t\t\treused = 0
\t\t}
\t} else {
\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\tif ok {
\t\t\td.root = h
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t} else {
\t\t\td.root = -1
\t\t\td.entries = nil
\t\t\td.entryHs = nil
\t\t}
\t\treused = 0
\t}`
    : `\treused := 0
\th, _, _, ok := parseWithMetaW(d.text, d.toks, d.b)
\tif ok {
\t\td.root = h
\t} else {
\t\td.root = -1
\t}`;

  // A text that does not lex: no tree, no entries (the next edit parses afresh).
  const lexClear = (topReuse
    ? ['d.root = -1', 'd.entries = nil', 'd.entryHs = nil']
    : ['d.root = -1']).map((l) => `\t\t${l}`).join('\n');
  const editBody = goEditBody(lexClear, false);

  const initAssign = topReuse
    ? `\t\td.root = h
\t\td.entries = entries
\t\td.entryHs = entryHs`
    : `\t\td.root = h`;

  return `${shiftHandleFn}${parseWithMetaW}${tryReuseTopW}${tryReuseSegW}
// Document is the shared surface of NewDoc (*Doc) and NewDocWith (*DocWith).
type Document interface {
	SetValidate(v bool)
	Text() string
	Root() int32
	Align() *Align
	Edit(edits []Edit) int32
}

// DocWith holds a consumer Builder + optional EntryMeta reuse (W path).
type DocWith struct {
	text     string
	root     int32
	toks     []alignMeta
	align    *Align
	validate bool
	b        Builder${entriesFields}
}

// NewDocWith: *CstBuilder → a Doc whose tree lives in that builder (CST fast path, S3). Other
// builders → DocWith (parserW).
func NewDocWith(src string, b Builder) Document {
	if cb, is := b.(*CstBuilder); is {
		return newDocCst(src, cb)
	}
	return newDocWith(src, b)
}

func newDocWith(src string, b Builder) *DocWith {
	d := &DocWith{text: src, b: b}
	var err *lexErr
	d.toks, err = ${initToks}
	if err != nil { panic(lexError(src, err)) }
	${topReuse ? 'h, entries, entryHs, ok' : 'h, _, _, ok'} := parseWithMetaW(src, d.toks, b)
	if ok {
${initAssign}
	} else {
		d.root = -1
	}
	return d
}

func (d *DocWith) SetValidate(v bool) { d.validate = v }
func (d *DocWith) Text() string       { return d.text }
func (d *DocWith) Root() int32        { return d.root }
func (d *DocWith) Align() *Align      { return d.align }

func (d *DocWith) Edit(edits []Edit) (ret int32) {
	oldText, oldToks := d.text, d.toks
${editBody}
	oldN, newN, prefix, suffix := computeAlignCore(oldText, oldToks, d.text, d.toks)
${editReuse}
	a := &Align{OldN: oldN, NewN: newN, Prefix: prefix, Suffix: suffix, Relexed: relexed, Reused: reused}
	if d.validate {
		v := checkStreamEq(d.text, d.toks)
		a.StreamEq = &v
		// Non-CST builders: treeEq reports nil (rust SUPPORTS_TREE_EQ=false).
	}
	d.align = a
	ret = d.root
	return
}
`;
}

// The `ahead` test's table: whether a token is in tokenSets[k] (see tokenSetBits).
function tokenSetRuntimeGo(ir: ParserIR, ids: LexIdPlan): string {
  const b = tokenSetBits(ids, ir.tokenSets);
  const rows: string[] = [];
  for (let r = 0; r * b.width < b.words.length; r++) rows.push(`{${b.words.slice(r * b.width, (r + 1) * b.width).join(', ')}}`);
  return `const _tokenSetKid = ${b.kidBase}
var _tokenSets = [...][${b.width}]uint32{${rows.join(', ')}}
func inTokenSet(k int, t *Tok) bool {
\tw := k >> 5
\treturn (_tokenSets[t.Lid][w]|_tokenSets[_tokenSetKid+int(t.Kid)][w])&(1<<(k&31)) != 0
}
// inCtxWords: whether t is a word the context ctx reserves (ParserIR.ctxWords): with the \`ahead\` test
// of the guard's own set, an \`aheadCtx\` test.
func inCtxWords(ctx uint8, t *Tok) bool { return false${ctxWordLids(ir, ids).map((w) => ` || (ctx&${w.bit} != 0 && t.Lid == ${w.lid})`).join('')} }`;
}

function emitBuilderAddonGo(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const reuse = ir.reuse;
  const dropTtIds = ['$punct', '$keyword', '$operator']
    .map((n) => {
      try { return ttIdOf(ar, n); } catch { return null; }
    })
    .filter((x): x is number => x !== null);
  const punctId = TT_SKIP_PUNCT;
  // The leaf types SlimBuilder never keeps: its Leaf's switch and its drop table (dropsLeaves).
  const slimDropIdList = [...new Set([...dropTtIds, punctId])];
  const slimDropIds = slimDropIdList.join(', ');
  // Selection: *CstBuilder parses with the direct engine (parseWithCst); other Builders use the
  // builder engine parserW. Why two engines: measured 2026-11-22 on 7fe75f9 (measure-profile,
  // Go Callgrind instructions per reuse parse, checker.ts / gen-tm.ts / typescript.d.ts /
  // dense-semi.ts), routing *CstBuilder through parserW costs +34.6% / +32.7% / +32.7% / +42.4%
  // (interface Builder), and still +25.2% / +23.3% / +22.0% / +26.9% with parserW's builder
  // field typed *CstBuilder (no interface: the bound of any devirtualisation). A generic
  // parserW[B Builder] does not close the first gap: Go 1.27 stencils one instantiation per GC
  // shape, and even a struct-typed B with its own shape calls B's methods through the dictionary
  // (an indirect call, not inlined; objdump of a minimal program). So about 9 points are the
  // interface and about 25 are parserW's own steps (leaf push through peek + Builder.Leaf, the
  // spanned return of every rule, a builder checkpoint per mark): one engine is not taken until
  // parserW is rebuilt on the direct engine's steps and the interface's ~9% is measured again.
  const wMethods = emitParserMethodsW('parserW', ir, ids, ar);
  const topReuse = ir.reuse;
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse && topReuse.kind === 'B' && topReuse.hasHead);
  const initToks = 'scanMeta(src)';
  const entryCst = ir.entry;
  const entryRid = ruleIdOf(ar, entryCst);
  const docWithBlock = emitDocWithGo(ir, entryRid, shapeA, shapeB, hasHeadB, !!topReuse, initToks);
  // The span of a built-in builder's node (an arena of Nodes) from its first and last children,
  // read in place as SpanOf of each would read it; only an operator leaf at a '>' (leafEnd) needs a call.
  const gtLeaf = ids.gtComps.length ? `; if tt == ${ttIdOf(ar, '$operator')} && t.Lid == ${lidOf(ids, '>')} { end = leafEnd(toks, ti, tt) }` : '';
  const kidsSpanGo = `\tif nn > sb {
\t\tif first := s[sb]; first < 0 { ti, _ := decodeLeaf(first); off = toks[ti].Off } else { off = b.Nodes[first].Offset }
\t\tif last := s[nn-1]; last < 0 { ${gtLeaf ? 'ti, tt' : 'ti, _'} := decodeLeaf(last); t := &toks[ti]; end = t.End${gtLeaf} } else { end = b.Nodes[last].End }
\t}
`;
  return `// ─── Builder API (additive; CST parse() / Doc above are unchanged) ───────────
// Builder is pure / bottom-up. Backtracking truncates scratch (+ optional arena
// checkpoint); discarded handles are garbage.
// *CstBuilder hot path = the native engine. Interface path = parserW.
// Optional shift: separate Shifter interface (Go has no optional methods); type
// assert. treeEq capacity = *CstBuilder identity (NewDocWith routes Cst → NewDoc).

type Builder interface {
\tLeaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool
\tFinish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (h int32, off uint32, present bool)
\tNode(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32)
\tSpanOf(h int32, toks []Tok) (uint32, uint32)
\tHeadSpan(h int32, toks []Tok) (uint32, uint32)
\tCheckpoint() (nb, kb int)
\tRestore(nb, kb int)
}

// Shifter is the optional incremental contract. Presence (type assert) ⇒ DocWith
// edit may reuse; absence ⇒ every edit is a fresh ParseWith (reused=0).
type Shifter interface {
\tShift(h int32, byteDelta, tokDelta int) int32
}

// spanned: span fields are independent of the handle (Pratt never reads H for spans).
type spanned struct {
\th int32
\toff, tokStart uint32
\tpresent bool
}

func builderFinishDefault(b Builder, scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\tnn := len(*scratch)
\tvar offset, end uint32
\tif nn > sb {
\t\to0, _ := b.SpanOf((*scratch)[sb], toks)
\t\t_, e1 := b.SpanOf((*scratch)[nn-1], toks)
\t\toffset, end = o0, e1
\t} else {
\t\toffset, end = fallbackOff, fallbackOff
\t}
\tb.Node(scratch, sb, ruleId, offset, end, tokStart, tokEnd)
\tn := len(*scratch) - sb
\tif n == 1 {
\t\th := (*scratch)[len(*scratch)-1]
\t\t*scratch = (*scratch)[:len(*scratch)-1]
\t\treturn h, offset, true
\t} else if n == 0 {
\t\treturn 0, offset, false
\t}
\th := (*scratch)[sb]
\t*scratch = (*scratch)[:sb]
\treturn h, offset, true
}

// Leaves index Toks, the token stream of the builder's last tree.
type CstBuilder struct {
\tNodes []Node
\tKids  []int32
\tToks  []Tok
\tws    Workspace
}
func (b *CstBuilder) Workspace() *Workspace { return &b.ws }

// Workspace holds the engine's transient buffers between parses: the child scratch list${reuse ? ', the\n// top-level entry records' : ''}${reuse?.kind === 'B' ? ' and segments' : ''} and the lexer's stacks. ParseWith empties and reuses the
// Workspace of a builder that has one (WorkspaceOwner), so a builder kept across parses does not
// allocate them again: the Rust target's Builder::workspace_mut. Its fields are the engine's.
type Workspace struct {
\tscratch []int32
${reuse ? '\tentries []EntryMeta\n' : ''}\tlex     lexStacks
\t// The builder engine's state, with its own scratch${reuse ? ' and entry lists' : ''}: kept here because Go's escape analysis
\t// moves a parserW to the heap (one allocation per parse otherwise); emptied after each parse.
\tw parserW
}
// WorkspaceOwner is the optional contract by which a builder keeps a Workspace (embed one and
// return its address); without it every ParseWith starts from new buffers.
type WorkspaceOwner interface { Workspace() *Workspace }

func (b *CstBuilder) Checkpoint() (nb, kb int) { return len(b.Nodes), len(b.Kids) }
func (b *CstBuilder) Restore(nb, kb int) { b.Nodes = b.Nodes[:nb]; b.Kids = b.Kids[:kb] }
func (b *CstBuilder) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
\t_ = off; _ = end
\tif ttId == ${punctId} { return false }
\t*scratch = append(*scratch, encodeLeaf(tokIdx, uint8(ttId)))
\treturn true
}
// Finish is a byte-twin of native finish (always creates a node, present=true).
func (b *CstBuilder) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\ts := *scratch
\tnn := len(s)
\tkidStart := len(b.Kids)
\toff, end := fallbackOff, fallbackOff
${kidsSpanGo}\tb.Kids = append(b.Kids, s[sb:nn]...)
\t*scratch = s[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\treturn int32(len(b.Nodes) - 1), off, true
}

func (b *CstBuilder) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
\tnn := len(*scratch)
\tkidStart := len(b.Kids)
\tb.Kids = append(b.Kids, (*scratch)[sb:nn]...)
\t*scratch = (*scratch)[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\t*scratch = append(*scratch, int32(len(b.Nodes)-1))
}
func (b *CstBuilder) SpanOf(h int32, toks []Tok) (uint32, uint32) {
\treturn cstKidOffEnd(b.Nodes, toks, h)
}
func (b *CstBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
\tid := h
\tfor {
\t\tif id < 0 {
\t\t\tti, tt := decodeLeaf(id)
\t\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}
func cstKidOffEnd(nodes []Node, toks []Tok, kid int32) (uint32, uint32) {
\tif kid < 0 {
\t\tti, tt := decodeLeaf(kid)
\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t}
\tnd := &nodes[kid]
\treturn nd.Offset, nd.End
}

type SlimBuilder struct {
\tNodes []Node
\tKids  []int32
\tToks  []Tok
\tws    Workspace
}
func (b *SlimBuilder) Workspace() *Workspace { return &b.ws }

func (b *SlimBuilder) Checkpoint() (nb, kb int) { return len(b.Nodes), len(b.Kids) }
func (b *SlimBuilder) Restore(nb, kb int) { b.Nodes = b.Nodes[:nb]; b.Kids = b.Kids[:kb] }
func (b *SlimBuilder) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
\t_ = off; _ = end
\tswitch ttId { case ${slimDropIds}: return false }
\t*scratch = append(*scratch, encodeLeaf(tokIdx, uint8(ttId)))
\treturn true
}
// dropsLeaves: the leaf types a SlimBuilder never keeps (punctuation, keywords, operators: the
// ids its Leaf refuses), as a table (no package-level state: built per parse).
func (b *SlimBuilder) dropsLeaves() (t [256]bool) {
\t${slimDropIdList.map((id) => `t[${id}]`).join(', ')} = ${slimDropIdList.map(() => 'true').join(', ')}
\treturn
}
// leafDropper: a built-in builder that declares the leaf types it never keeps, read once per parse
// (dropsOf), so that the builder engine does not offer them: a Leaf call through the Builder
// interface is a dynamic call in Go (Rust's builder engine is monomorphised and inlines the test).
// Any other Builder is offered every leaf.
type leafDropper interface{ dropsLeaves() [256]bool }
func dropsOf(b Builder) [256]bool {
\tif d, ok := b.(leafDropper); ok { return d.dropsLeaves() }
\treturn [256]bool{}
}
// Finish is builderFinishDefault with the spans read in place and Node's collapse inline, decided
// before the spans are read.
func (b *SlimBuilder) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\ts := *scratch
\tnn := len(s)
\tswitch nn - sb {
\tcase 0:
\t\t// The root keeps its node with no child: an accepted parse always has a root (ParseWith).
\t\tif ruleId != ${entryRid} { return 0, fallbackOff, false }
\tcase 1:
\t\t// Collapsed to its one child: only the child's start is read (no end, no node).
\t\t*scratch = s[:sb]
\t\tif h := s[sb]; h < 0 { ti, _ := decodeLeaf(h); return h, toks[ti].Off, true } else { return h, b.Nodes[h].Offset, true }
\t}
\toff, end := fallbackOff, fallbackOff
${kidsSpanGo}\tkidStart := len(b.Kids)
\tb.Kids = append(b.Kids, s[sb:nn]...)
\t*scratch = s[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\treturn int32(len(b.Nodes) - 1), off, true
}
func (b *SlimBuilder) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
\tnn := len(*scratch)
\tcount := nn - sb
\tif count == 1 { return }
\t// The root keeps its node with no child: an accepted parse always has a root (ParseWith).
\tif count == 0 && ruleId != ${entryRid} { *scratch = (*scratch)[:sb]; return }
\tkidStart := len(b.Kids)
\tb.Kids = append(b.Kids, (*scratch)[sb:nn]...)
\t*scratch = (*scratch)[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(count), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\t*scratch = append(*scratch, int32(len(b.Nodes)-1))
}
func (b *SlimBuilder) SpanOf(h int32, toks []Tok) (uint32, uint32) {
\tif h < 0 {
\t\tti, tt := decodeLeaf(h)
\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t}
\tnd := &b.Nodes[h]
\treturn nd.Offset, nd.End
}
func (b *SlimBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
\tid := h
\tfor {
\t\tif id < 0 {
\t\t\tti, tt := decodeLeaf(id)
\t\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}

${wMethods}
// parseWithCst: concrete hot path — the native engine building into the builder's arena.
// Keeps ParseWith(CstBuilder) within the additive-prefix / byte-equal contract
// without paying for a second method-instantiation (Go GC-shape stenciling tax).
func parseWithCst(src string, b *CstBuilder) (int32, bool) {
\tw := &b.ws
\tp := &engine{nodes: b.Nodes[:0], kids: b.Kids[:0], scratch: w.scratch[:0]${reuse ? ', entries: w.entries[:0]' : ''}}
\ttoks, err := lexInto(src, b.Toks, &w.lex)
\tif err != nil { panic(lexError(src, err)) }
\th := p.parse(src, toks)
\tb.Nodes, b.Kids, b.Toks, w.scratch = p.nodes, p.kids, p.toks, p.scratch${reuse ? '\n\tw.entries = p.entries' : ''}
\tif h < 0 { return 0, false }
\treturn h, true
}
// parseWithW: a builder that parsed before is reused as parse_with does in the Rust target: its
// arena is emptied, its token buffer (the built-in builders') and Workspace are emptied and reused
// (capacity kept), so nothing of the previous parse stays reachable and nothing is allocated again.
func parseWithW(src string, b Builder) (int32, bool) {
\tvar w *Workspace
\tif o, is := b.(WorkspaceOwner); is { w = o.Workspace() } else { w = &Workspace{} }
\tb.Restore(0, 0)
\tp := &w.w
\ttoks, err := lexInto(src, toksOf(b), &w.lex)
\tif err != nil { panic(lexError(src, err)) }
\t*p = parserW{cursor: cursor{toks: toks}, src: src, b: b, drops: dropsOf(b), scratch: p.scratch[:0]${reuse ? ', entries: p.entries[:0], entryHs: p.entryHs[:0]' : ''}}
\tfr, ok := p.parse${ir.entry}W()
\trecordToks(b, p.toks)
\tok = ok && p.pos == len(p.toks)
\tp.cursor.toks, p.src, p.b = nil, "", nil // the workspace keeps buffers, not the input or the builder
\tif !ok { return 0, false }
\tif !fr.present { panic(errNoRoot) }
\treturn fr.h, true
}

// errNoRoot: an accepted parse whose builder kept no node for the root (the entry rule). Accepting
// or rejecting is the parser's verdict, never the builder's, so this is no reject: it is a builder
// that breaks the contract (the built-in builders always keep the root), reported loudly.
const errNoRoot = "the builder kept no node for the root rule of an accepted parse (a Builder must return one for the entry rule)"

// ParseWith runs the builder-driven parse. *CstBuilder uses the concrete hot path (the native
// engine); other Builders (e.g. *SlimBuilder) use interface parserW.
// ok=false is reject (distinct from a leaf handle, which may also be negative).
func ParseWith(src string, b Builder) (h int32, ok bool) {
\tif cb, is := b.(*CstBuilder); is {
\t\treturn parseWithCst(src, cb)
\t}
\treturn parseWithW(src, b)
}

func writeKidWith(nodes []Node, kids []int32, toks []Tok, v int32, b *strings.Builder) {
\tif v < 0 {
\t\tti, tt := decodeLeaf(v)
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", TT_NAMES[tt], toks[ti].Off, leafEnd(toks, ti, tt))
\t\treturn
\t}
\twriteJSONWith(nodes, kids, toks, v, b)
}
func writeJSONWith(nodes []Node, kids []int32, toks []Tok, id int32, b *strings.Builder) {
\tnd := &nodes[id]
\tfmt.Fprintf(b, "{\\"rule\\":%q,\\"children\\":[", RULE_NAMES[nd.RuleId])
\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\tif i > 0 { b.WriteByte(',') }
\t\twriteKidWith(nodes, kids, toks, kids[nd.KidStart+i], b)
\t}
\tfmt.Fprintf(b, "],\\"offset\\":%d,\\"end\\":%d}", nd.Offset, nd.End)
}

${docWithBlock}
// recordToks hands the built-in builders the parse stream their leaves index.
// toksOf: the token buffer of a built-in builder's last tree, which its next parse lexes into.
func toksOf(b Builder) []Tok {
\tswitch x := b.(type) {
\tcase *CstBuilder:
\t\treturn x.Toks
\tcase *SlimBuilder:
\t\treturn x.Toks
\t}
\treturn nil
}
func recordToks(b Builder, ts []Tok) {
\tswitch x := b.(type) {
\tcase *CstBuilder:
\t\tx.Toks = ts
\tcase *SlimBuilder:
\t\tx.Toks = ts
\t}
}
func CstJSONWith(b *CstBuilder, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, b.Toks, root, &buf)
\treturn buf.String()
}
func SlimJSONWith(b *SlimBuilder, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, b.Toks, root, &buf)
\treturn buf.String()
}
`;
}

const GO_TYPES: Record<Ty, string> = {
  int: 'int', lid: 'uint16', depth: 'int', pos: 'int', idx: 'int', bool: 'bool', str: 'string', meta: 'alignMeta', tok: 'Tok', edit: 'Edit',
  metas: '[]alignMeta', toks: '[]Tok', bools: '[]bool', depths: '[]int', edits: '[]Edit',
};
const GO_META: Record<MetaInt, string> = { off: 'int32', end: 'int32', kid: 'uint16', pd: 'uint16', fd: 'uint16', td: 'uint8' };
const GO_TOK: Record<TokInt, string> = { off: 'uint32', end: 'uint32', kid: 'uint16', lid: 'uint16' };
const GO_MK: Record<keyof MkMeta, string> = { off: 'int32', end: 'int32', kid: 'uint16', nl: 'bool', fd: 'uint16', pd: 'uint16', lc: 'bool', lb: 'bool', hd: 'bool', td: 'uint8' };
// Operator spelling and binding strength; unary is 90, a negative literal 7.
const GO_OPS: Record<BinOp, [string, number]> = {
  or: ['||', 1], and: ['&&', 2], eq: ['==', 3], ne: ['!=', 3], lt: ['<', 4], le: ['<=', 4], gt: ['>', 4], ge: ['>=', 4], shr: ['>>', 5], shl: ['<<', 5], add: ['+', 6], sub: ['-', 6],
};
const GO_IND = '\t';
const exported = (s: string): string => s[0].toUpperCase() + s.slice(1);
const goWrap = (r: R, min: number): string => (r.prec < min ? `(${r.c})` : r.c);
const goBlock = (lines: string[]): string[] => lines.map((l) => GO_IND + l);

// Shared-algorithm lowering: explicit conversions, slices; a list with an exact final length is
// made with that capacity, any other list grows by append (no estimate is reserved: 6183a29).
// Go: a type's export is its spelling, so a record outside the package API (the Doc's EntryMeta
// is in it) is spelled unexported.
const GO_API_RECORDS = new Set(['EntryMeta']);
const goRec = (r: string): string => (GO_API_RECORDS.has(r) ? r : r[0]!.toLowerCase() + r.slice(1));
const goType = (t: Ty): string => (isRecList(t) ? `[]${goRec(recName(t))}` : isRec(t) ? goRec(recName(t)) : isOpt(t) ? `*${goRec(recName(t))}` : GO_TYPES[t]);
// A Go string literal; Go rejects a byte order mark inside a source file, so it is an escape.
const goLit = (v: string): string => JSON.stringify(v).replace(/\ufeff/g, '\\uFEFF');
const goLowering: Lowering = {
  units: UNITS,
  ident: (n) => n,
  num: { int: 'int', lid: 'uint16', depth: 'int', pos: 'int', idx: 'int' },
  type: (t) => goType(t),
  cast: (_cx, r, nat) => ({ ...r, c: `${nat}(${r.c})`, nat, prec: ATOM }),
  owns: false,
  spliceInline: true,
  charSet: (name, rs) => `var ${name} = [256]bool{${rs.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => `${lo + k}: true`)).join(', ')}}`,
  // A byte loop: Rust's four-bytes-per-round shape measured slower here (measure-targets, PR #138:
  // go-reuse +2.9% to +3.8% on acorn / checker / gen-tm), the compiler keeps the loop tight already.
  runEndFn: `// lexRunEnd is the end of the run of bytes in set from i: the first j >= i at which s ends or s[j] is not in it.
func lexRunEnd(s string, i int, set *[256]bool) int {
\tfor i < len(s) && set[s[i]] {
\t\ti++
\t}
\treturn i
}`,
  findFn: `// lexFind is where lit next occurs in s from i: the first j >= i at which s has it, or len(s).
func lexFind(s string, i int, lit string) int {
\tif k := strings.Index(s[i:], lit); k >= 0 {
\t\treturn i + k
\t}
\treturn len(s)
}`,
  // Per window of 256 bytes, the standard library's byte search (assembly, many bytes per step:
  // faster in Go than a word-at-a-time loop, which Go compiles without ANDN and with each mask
  // constant reloaded per word) for each byte a stop begins with, each search bounded by the
  // nearest stop found so far; a stop of several bytes is confirmed in place. The window keeps
  // the work linear when a stop is absent from the rest of the input.
  findAnyFn: (stops) => {
    const { one, wide } = stopBytes(stops);
    const hex = (b: number) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
    const goStr = (q: number[]) => `"${q.map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('')}"`;
    const ones = one.map((b) => `\t\tif k := strings.IndexByte(s[i:e], ${hex(b)}); k >= 0 {\n\t\t\te = i + k\n\t\t}`);
    const leads = [...new Set(wide.map((w) => w.head[0]!))];
    const wides = leads.map((lead) => {
      const here = wide.filter((w) => w.head[0] === lead).map((w) => `(strings.HasPrefix(s[j:], ${goStr(w.head)}) && j+${w.head.length} < len(s) && (${w.last.map((l) => `s[j+${w.head.length}] == ${hex(l)}`).join(' || ')}))`).join(' || ');
      return `\t\tfor j := i; ; j++ {
\t\t\tk := strings.IndexByte(s[j:e], ${hex(lead)})
\t\t\tif k < 0 {
\t\t\t\tbreak
\t\t\t}
\t\t\tj += k
\t\t\tif ${here} {
\t\t\t\te = j
\t\t\t\tbreak
\t\t\t}
\t\t}`;
    });
    return `// ${findAnyName(stops)} is where the next of ${stops.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')} is in s from i: the index of its first byte, or len(s).
func ${findAnyName(stops)}(s string, i int) int {
\tfor i < len(s) {
\t\tw := len(s)
\t\tif w-i > 256 {
\t\t\tw = i + 256
\t\t}
\t\te := w
${[...ones, ...wides].join('\n')}
\t\tif e < w {
\t\t\treturn e
\t\t}
\t\ti = w
\t}
\treturn i
}`;
  },
  expr: {
    literal: (v) => ({ c: typeof v === 'string' ? goLit(v) : String(v), prec: typeof v === 'number' && v < 0 ? 7 : ATOM }),
    not: (r) => ({ c: `!${goWrap(r, ATOM)}`, prec: 90 }),
    bin: (op, a, b) => {
      const [sp, p] = GO_OPS[op];
      const side = (r: R, right: boolean): string =>
        (r.prec < p || (right && r.prec === p) || ((op === 'shr' || op === 'shl') && r.prec < ATOM) || (COMPARISON.has(op) && r.prec >= 3 && r.prec <= 4) ? `(${r.c})` : r.c);
      return { c: `${side(a, false)} ${sp} ${side(b, true)}`, prec: p };
    },
    call: (name, args) => `${name}(${args.join(', ')})`,
    len: (cx, l) => cx.atom(`len(${l.c})`, 'int', 'int'),
    code: (cx, s, i) => cx.atom(`int(${goWrap(s, ATOM)}[${i.c}])`, 'int', 'int'),
    hasAt: (cx, s, i, lit) => cx.atom(`strings.HasPrefix(${goWrap(s, ATOM)}[${i.c}:], ${goLit(lit)})`, 'bool', 'bool'),
    inSet: (cx, set, c) => cx.atom(`${set}[${c.c}]`, 'bool', 'bool'),
    runEnd: (cx, set, s, i) => cx.atom(`lexRunEnd(${s.c}, ${i.c}, &${set})`, 'int', 'int'),
    find: (cx, s, i, lit) => cx.atom(`lexFind(${s.c}, ${i.c}, ${JSON.stringify(lit)})`, 'int', 'int'),
    findAny: (cx, s, i, stops) => cx.atom(`${findAnyName(stops)}(${s.c}, ${i.c})`, 'int', 'int'),
    own: (_cx, r) => r,
  },
  stmt: {
    comment: (text) => [`// ${text}`],
    let: (cx, s) => {
      if (s.emptyList) return [`var ${s.id} ${cx.type(s.ty, 'local')}`];
      if (!isNum(s.ty)) return [`${s.id} := ${s.r.c}`];
      const nat = cx.nat(s.ty);
      if (s.r.lit) return [nat === 'int' ? `${s.id} := ${s.r.c}` : `var ${s.id} ${nat} = ${s.r.c}`];
      return [`${s.id} := ${cx.coerce(s.r, nat)}`];
    },
    set: (id, val) => [`${id} = ${val}`],
    if: (s) => {
      const head = `if ${s.c}`;
      if (s.inline !== undefined && GO_IND.length * s.depth + head.length + s.inline.length + 5 <= 110) return [`${head} { ${s.inline} }`];
      return [`${head} {`, ...goBlock(s.then), ...(s.else ? ['} else {', ...goBlock(s.else)] : []), '}'];
    },
    while: (c, body) => [`for ${c} {`, ...goBlock(body), '}'],
    break: () => ['break'],
    run: (call) => call,
    return: (vals) => [`return ${vals.join(', ')}`],
    fn: (f) => [
      ...f.doc.map((l) => `// ${l}`),
      ...(f.cold ? ['//go:noinline'] : []),
      `func ${f.name}(${f.params.map((p) => `${p.name} ${p.type}`).join(', ')}) ${f.rets.length === 0 ? '' : f.rets.length === 1 ? `${f.rets[0]} ` : `(${f.rets.join(', ')}) `}{`,
      ...goBlock(f.body),
      '}',
    ].join('\n'),
  },
  relex: {
    index: 'int',
    expr: {
      index: (l, i) => ({ c: `${goWrap(l, ATOM)}[${i.c}]`, prec: ATOM }),
      metaInt: (cx, m, f) => cx.atom(`${goWrap(m, ATOM)}.${exported(f)}`, 'int', GO_META[f]),
      metaFlag: (cx, m, f) => cx.atom(`am${exported(f)}(${m.c})`, 'bool', 'bool'),
      tokInt: (cx, t, f) => cx.atom(`${goWrap(t, ATOM)}.${exported(f)}`, 'int', GO_TOK[f]),
      tokNl: (cx, t) => cx.atom(`${goWrap(t, ATOM)}.Nl`, 'bool', 'bool'),
      editInt: (cx, e, f) => cx.atom(`${e.c}.${exported(f)}`, 'int', 'int'),
      editText: (cx, e) => cx.atom(`${e.c}.Text`, 'str', 'str'),
      metaText: (cx, t, m) => cx.atom(`amText(${t.c}, ${m.c})`, 'str', 'str'),
      substr: (cx, s, a, b) => cx.atom(`${goWrap(s, ATOM)}[${cx.coerce(a, 'int')}:${cx.coerce(b, 'int')}]`, 'str', 'str'),
      lidOf: (cx, s) => cx.atom(`lidOf(${s.c})`, 'lid', cx.nat('lid')),
      mkMeta: (cx, fs) => cx.atom(`mkAlign(${fs.map(([f, r]) => cx.coerce(r, GO_MK[f])).join(', ')})`, 'meta', 'meta'),
      shiftMeta: (cx, m, d) => cx.atom(`shiftAlign(${m.c}, ${cx.coerce(d, 'int')})`, 'meta', 'meta'),
      metaEq: (_cx, a, b) => ({ c: `${a.c} == ${b.c}`, ty: 'bool', nat: 'bool', prec: GO_OPS.eq[1] }),
      splice: (cx, s, a, b, ins) => ({ c: `${goWrap(s, ATOM)}[:${cx.coerce(a, 'int')}] + ${ins.c} + ${goWrap(s, ATOM)}[${cx.coerce(b, 'int')}:]`, ty: 'str', nat: 'str', prec: GO_OPS.add[1] }),
      newList: (cx, ty, cap) => cx.atom(cap ? `make(${goType(ty)}, 0, ${cx.coerce(cap, 'int')})` : 'nil', ty, ty, { owned: true }),
      falses: (cx, n) => cx.atom(`make([]bool, ${cx.coerce(n, 'int')})`, 'bools', 'bools', { owned: true }),
      prefix: (cx, l, n, estimate) => cx.atom(`append(make(${goType(l.ty)}, 0, ${cx.coerce(estimate, 'int')}), ${goWrap(l, ATOM)}[:${cx.coerce(n, 'int')}]...)`, l.ty, l.ty, { owned: true }),
    },
    stmt: {
      setAt: (id, i, val) => [`${id}[${i}] = ${val}`],
      push: (_cx, l, r) => [`${l} = append(${l}, ${r.c})`],
      for: (cx, v, from, to, body) => [`for ${v} := ${cx.coerce(from, 'int')}; ${v} < ${cx.coerce(to, 'int')}; ${v}++ {`, ...goBlock(body), '}'],
      forEach: (v, l, body) => [`for _, ${v} := range ${l} {`, ...goBlock(body), '}'],
      destructure: (_cx, s) => [`${s.ids.join(', ')} ${s.declare ? ':=' : '='} ${s.call}`],
      lexStep: (_cx, s) => [`${[s.pos, ...s.state, s.err].join(', ')} = lexFrom(${s.text.c}, ${s.pos}, ${[...s.state, `&${s.out}`].join(', ')}, 1)`],
      lexAll: (_cx, s) => [`${s.out}, ${s.err} := lexAll(${s.text.c})`],
    },
  },
  record: {
    field: (cx, r, _rec, f, ty, nat) => cx.atom(`${goWrap(r, ATOM)}.${exported(f)}`, ty, nat),
    setField: (id, f, val) => [`${id}.${exported(f)} = ${val}`],
    make: (cx, rec, fs) => cx.atom(`${goRec(rec)}{${fs.map(([f, v]) => `${exported(f)}: ${v}`).join(', ')}}`, `rec_${rec}`, `rec_${rec}`, { owned: true }),
    refType: (rec) => `*${goRec(rec)}`,
    refArg: (r) => `&${r.c}`,
    extend: (_cx, l, from) => [`${l} = append(${l}, ${from.c}...)`],
    // A typed nil: it declares a local (:=) of the optional's type.
    none: (cx, rec) => cx.atom(`(*${goRec(rec)})(nil)`, `opt_${rec}`, `opt_${rec}`),
    some: (cx, rec, r) => cx.atom(`&${goWrap(r, ATOM)}`, `opt_${rec}`, `opt_${rec}`),
    isSome: (_cx, r) => ({ c: `${goWrap(r, 4)} != nil`, prec: 3 }),
  },
};

// No callee-FIRST body guards: a Go rd call refused at its dispatch costs less than the guard's test
// on every iteration (measured: starInC 35 -> 48 instructions per call, typescript.d.ts +0.46% reuse).
const FACTS: PortableFacts = { calleeFirstGuards: false };

export const goTarget = defineTarget({
  name: 'go',
  ext: 'go',
  lowering: goLowering,
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string {
    const ir = portableIR(grammar, FACTS);
    const ids = buildLexIdPlan(ir);
    const lexText = lexer(ir, ids, shared);
    const ar = buildArenaIdPlan(ir, ids);
    const reuse = ir.reuse;
    const ruleFns = [...ir.rules.filter((r) => ir.forms.buildRules.includes(r.name)).map((r) => {
      if (r.kind === 'pratt') return prattRule(r, ir, ids, ar);
      if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids, ar);
      return rdRule(r, ids, ar);
    }), ...ir.rules.filter((r) => ir.forms.recognizeRules.includes(r.name) && !ir.forms.cursorOnly.rules.includes(r.name)).map((r) => ruleR(r, ids, ENGINE_GO))].join('\n\n');
    // One template matcher per hole rule (tplHoleRules): the hole is parsed by the rule the
    // matching reference declares, called directly.
    const matchTemplate = tplHoleRules(ir).map((hole) => `func (p *engine) matchTemplate_${hole}() int32 {
\tt := p.peek()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return -1 }
\tsb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); save := p.pos
\tp.pushLeaf(${ttIdOf(ar, '$templateHead')}, uint32(p.pos)); p.pos++
\tfor {
\t\texpr := p.parse${hole}()
\t\tif expr < 0 { p.back(save); p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1 }
\t\tp.scratch = append(p.scratch, expr)
\t\tnext := p.peek()
\t\tif next == nil { p.back(save); p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1 }
\t\tif next.Kid == ${kidOf(ids, '$templateMiddle')} { p.pushLeaf(${ttIdOf(ar, '$templateMiddle')}, uint32(p.pos)); p.pos++; continue }
\t\tif next.Kid == ${kidOf(ids, '$templateTail')} { p.pushLeaf(${ttIdOf(ar, '$templateTail')}, uint32(p.pos)); p.pos++; break }
\t\tp.back(save); p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1
\t}
\treturn p.finish(${ruleIdOf(ar, '$template')}, sb, int(t.Off), save)
}
`).join('');
    return `// GENERATED by emit-portable.ts (goTarget) — parser LIBRARY (package parser) for grammar "${ir.grammarName}".
// Public API: Tokenize(src) []Token (the lexer alone, a fresh slice the caller owns), ParseWith /
// NewDoc / NewDocWith (CST). The CLI runner (stdin → CST JSON) is goTarget.emitRunner(): the
// verification gates compile it with this file as one \`package main\`.
package parser

import (
\t"fmt"
${lexText.includes('bits.') ? '\t"math/bits"\n' : ''}\t"strings"
\t"unicode/utf8"
)

// Slim hot-path token (kind/text via kindStr / src[Off:End]).
type Tok struct {
\tOff, End uint32
\tKid, Lid uint16
\tNl       bool
}
// Arena node: an int32 index into nodes; children are a flat range in kids (node indices or encoded leaf refs).
// Ext is lookahead watermark for top-level reuse (not emitted in JSON).
type Node struct {
\tRuleId uint16
\tKidStart, KidCount, Offset, End, TokStart, TokEnd, Ext uint32
}
type bp struct{ lbp, rbp int; tgt, noUnary, ok bool }
type preOp struct{ rbp int; tgt bool; form uint8; ok bool }
type postOp struct{ lbp int; tgt bool; ok bool }

// engine is one parse's mutable state: the token stream it reads, the cursor and lookahead watermark, the arena it builds into and the reuse
// metadata. A Doc owns one for its lifetime; ParseWith uses a fresh one per call. Nothing the
// parser or lexer mutates is package-level, so different Docs, ParseWith and Tokenize are
// independent (and safe from concurrent goroutines); a single Doc is not safe for concurrent use.
// mark: the position, scratch length and arena (or builder checkpoint) lengths a construct that
// may have to undo what it tries starts from (engine.mark / reset, parserW.mark / reset).
type mark struct{ pos, sb, nb, kb int }
type engine struct {
\tcursor
\tcapped bool
\tform uint8 // assignment-target form of the node the last nud_/bp_ call returned
\ttail bool  // whether the node the last nud_ call returned closes the access tail
\tsrc string
\tnodes []Node
\tkids []int32
\tscratch []int32
\tarenaBaseline int
${reuse ? '\tentries []EntryMeta\n' : ''}}
const arenaCompactK = 4

${renderArenaTablesGo(ar, ids)}

${lexText}

// Public token (the tokenizer's output model).
type Token struct {
\tKind, Text string
\tOff, End   int
\tNl         bool
\tKid, Lid   uint16
}

// LexError reports input the lexer cannot tokenize. Tokenize returns it; ParseWith and the
// Doc constructors panic with it.
type LexError struct {
\tOff int
\tMsg string
}

func (e *LexError) Error() string { return e.Msg }

// lexError is the LexError of the lexer's error e in src.
func lexError(src string, e *lexErr) *LexError {
\tswitch e.Kind {
\tcase 0:
\t\tr, _ := utf8.DecodeRuneInString(src[e.Off:])
\t\treturn &LexError{Off: e.Off, Msg: fmt.Sprintf("Unexpected character at offset %d: '%c'", e.Off, r)}
\tcase 1:
\t\treturn &LexError{Off: e.Off, Msg: fmt.Sprintf("Invalid identifier escape at offset %d: '%s'", e.Off, src[e.Off:e.End])}
\tcase 2:
\t\treturn &LexError{Off: e.Off, Msg: fmt.Sprintf("Unterminated template literal at offset %d", e.Off)}
\t}
\treturn &LexError{Off: e.Off, Msg: fmt.Sprintf("Invalid escape sequence in template at offset %d", e.Off)}
}

// lex is the tokens of src; a lexer error panics (*LexError).
func lex(src string) []Tok {
\ttoks, err := lexAll(src)
\tif err != nil { panic(lexError(src, err)) }
\treturn toks
}

// Tokenize is the lexer alone: a fresh slice the caller owns.
func Tokenize(src string) ([]Token, error) {
\tslim, lerr := lexAll(src)
\tif lerr != nil { return nil, lexError(src, lerr) }
\tout := make([]Token, len(slim))
\tfor i := range slim {
\t\tt := &slim[i]
\t\tout[i] = Token{Kind: tokKind(t), Text: tokText(src, t), Off: int(t.Off), End: int(t.End), Nl: t.Nl, Kid: t.Kid, Lid: t.Lid}
\t}
\treturn out, nil
}

func encodeLeaf(tokIdx uint32, ttId uint8) int32 {
\tif tokIdx >= (1 << 25) { panic("tok_idx exceeds 2^25-1") }
\tpacked := tokIdx | (uint32(ttId) << 25)
\treturn int32(^packed)
}
func decodeLeaf(v int32) (tokIdx uint32, ttId uint8) {
\tpacked := uint32(^v)
\treturn packed & ((1 << 25) - 1), uint8(packed >> 25)
}
${gtRuntimeGo(ids, ar)}
func (p *engine) pushLeaf(ttId uint8, tokIdx uint32) {
\tif ttId == TT_SKIP_PUNCT { return }
\tp.scratch = append(p.scratch, encodeLeaf(tokIdx, ttId))
}

${tokenSetRuntimeGo(ir, ids)}
${cursorGo(ir, ids)}
${engineMarkGo('engine')}
// Wrap the scratch entries [sb:] as one node's children (flattened into kids); truncate scratch.
// tokStart is the parse-consumption start (entry pos / leftmost operand), tokEnd is pos at finish.
func (p *engine) finish(ruleId uint16, sb, fallbackOff, tokStart int) int32 {
\tnn := len(p.scratch)
\tkidStart := len(p.kids)
\toff, end := uint32(fallbackOff), uint32(fallbackOff)
\tif nn > sb {
\t\tfirst := p.scratch[sb]
\t\tlast := p.scratch[nn-1]
\t\tif first < 0 {
\t\t\tti, _ := decodeLeaf(first)
\t\t\toff = uint32(p.toks[ti].Off)
\t\t} else {
\t\t\toff = p.nodes[first].Offset
\t\t}
\t\tif last < 0 {
\t\t\tti, _ := decodeLeaf(last)
\t\t\tend = uint32(p.toks[ti].End)
\t\t} else {
\t\t\tend = p.nodes[last].End
\t\t}
\t}
\tp.kids = append(p.kids, p.scratch[sb:nn]...)
\tp.scratch = p.scratch[:sb]
\tp.nodes = append(p.nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: uint32(tokStart), TokEnd: uint32(p.pos), Ext: 0})
\treturn int32(len(p.nodes) - 1)
}
func (p *engine) matchLit(lid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1 // the probe is a peek (TS/Rust matchLit go through peek())
\tif i >= len(p.toks) || p.toks[i].Lid != lid { return false }
\tif lid >= lidKw { p.scratch = append(p.scratch, encodeLeaf(uint32(i), ${ttIdOf(ar, '$keyword')})) }
\tp.pos = i + 1
\treturn true
}
// A token kind's leaf type id is its kid (ArenaIdPlan: TT_NAMES starts with the kids).
func (p *engine) matchTok(kid uint16) bool {
\ti := p.pos
\tp.peekEnd = i + 1
\tif i >= len(p.toks) || p.toks[i].Kid != kid { return false }
\tp.scratch = append(p.scratch, encodeLeaf(uint32(i), uint8(kid)))
\tp.pos = i + 1
\treturn true
}
// matchComp matches a composite '>'-led literal (a lookahead operand; never a tree leaf).
// callRule pushes the node a rule call returned (id < 0: the rule did not match).
func (p *engine) callRule(id int32) bool {
\tif id < 0 { return false }
\tp.scratch = append(p.scratch, id); return true
}
func (p *engine) star(once func() bool) bool {
\tfor { m := p.mark(); if !once() { p.reset(m); break } }
\treturn true
}
func (p *engine) starIn(k int, once func() bool) bool {
	for p.ahead(k, true) { m := p.mark(); if !once() { p.reset(m); break } }
	return true
}
// A clean body (Step.clean) leaves no trace when it fails: no mark, nothing to undo. Kept out of
// line (go:noinline), as the marked forms already are by Go's inline budget: inlined, these small
// helpers and their closures grew the frames of the large rule functions, and every call of those
// paid for it on paths that never run the helper (dense-semi: parseStmtW / parseDeclW +7.5
// instructions per call, Go builder Ir +5.3%).
//go:noinline
func (p *engine) starC(once func() bool) bool {
\tfor once() {}
\treturn true
}
//go:noinline
func (p *engine) starInC(k int, once func() bool) bool {
\tfor p.ahead(k, true) && once() {}
\treturn true
}
//go:noinline
func (p *engine) optC(body func() bool) bool { body(); return true }
//go:noinline
func (p *engine) sepByC(elem func() bool, delim uint16) bool {
\tif elem() { for p.matchLit(delim) && elem() {} }
\treturn true
}
func (p *engine) opt(body func() bool) bool {
\tm := p.mark(); if !body() { p.reset(m) }; return true
}
func (p *engine) sepBy(elem func() bool, delimLid uint16) bool {
\tm0 := p.mark()
\tif !elem() { p.reset(m0); return true }
\tfor {
\t\tif !p.matchLit(delimLid) { break } // a failed delimiter match changes nothing: no mark before it
\t\tm2 := p.mark()
\t\tif !elem() { p.reset(m2); break } // trailing delim OK — keep delim
\t}
\treturn true
}
func (p *engine) altLit(lids []uint16) bool {
\tfor _, lid := range lids { if p.matchLit(lid) { return true } }
\treturn false
}

${matchTemplate}${lookFnsR(ir, ids, ENGINE_GO, false)}${sharedFns(ir, ids, ar)}${sharedFnsR(ir, ids, ENGINE_GO, false)}${ruleFns}

func (p *engine) writeJSON(id int32, b *strings.Builder) { writeJSONWith(p.nodes, p.kids, p.toks, id, b) }

func (p *engine) headLeafText(id int32) string {
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := p.toks[ti]
\t\t\treturn p.src[t.Off:t.End]
\t\t}
\t\tnd := &p.nodes[id]
\t\tif nd.KidCount == 0 { break }
\t\tid = p.kids[nd.KidStart]
\t}
\tnd := &p.nodes[id]
\treturn p.src[nd.Offset:nd.End]
}
func _inW(ws []string, s string) bool { for _, w := range ws { if w == s { return true } }; return false }

// parse runs the parser over t, the tokens of src, into p's arena (internal — the public CST
// entries are ParseWith / NewDoc). src is also the source head-leaf lookups read.
func (p *engine) parse(src string, t []Tok) int32 {
\tp.src = src
\tp.toks = t
\tp.pos = 0
\tp.lookReset()
\tp.nodes = p.nodes[:0]; p.kids = p.kids[:0]; p.scratch = p.scratch[:0]
\troot := p.parse${ir.entry}()
\tp.arenaBaseline = len(p.nodes)
\t// Full-consumption guard (mirrors the TS wrapper): a partial parse is a reject, not a
\t// tree. Without this, Doc keeps a partial root after a rejecting edit and the next
\t// edit's reuse path resurrects it as if it were a valid old tree.
\tif root >= 0 && p.pos != len(p.toks) { return -1 }
\treturn root
}

${docEditBlockGo(ir, shared)}
${emitBuilderAddonGo(ir, ids, ar)}
`;
  },
  emitRunner(): string {
    return `// CLI runner (harness only): stdin -> CST JSON + a self-bench mode. A SEPARATE file; the
// gate writes it as runner.go next to the parser library with the library's package clause
// set to main, so the two build into an executable. NOT part of the parser.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tsrc := string(data)
\teditFast := len(os.Args) > 1 && os.Args[1] == "edit-session-fast"
\teditSess := editFast || (len(os.Args) > 1 && os.Args[1] == "edit-session")
\t// Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
\tif len(os.Args) > 1 && !editSess {
\t\tif iters, err := strconv.Atoi(os.Args[1]); err == nil && iters > 0 {
\t\t\tp := &engine{}
\t\t\tfor i := 0; i < 3; i++ { p.parse(src, lex(src)) }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { p.parse(src, lex(src)) }
\t\t\tfmt.Printf("%.4f\\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
\t\t\treturn
\t\t}
\t}
\tif editSess {
\t\tvar sess struct {
\t\t\tInit    string              \`json:"init"\`
\t\t\tBatches [][][3]interface{}   \`json:"batches"\`
\t\t}
\t\tif json.Unmarshal(data, &sess) != nil { os.Exit(1) }
\t\td := NewDoc(sess.Init)
\t\tif !editFast { d.SetValidate(true) }
\t\tfor _, batch := range sess.Batches {
\t\t\tedits := make([]Edit, len(batch))
\t\t\tfor i, t := range batch {
\t\t\t\tedits[i] = Edit{Start: int(t[0].(float64)), End: int(t[1].(float64)), Text: t[2].(string)}
\t\t\t}
\t\t\td.Edit(edits)
\t\t}
\t\tif a := d.Align(); a != nil { b, _ := json.Marshal(a); os.Stderr.Write(append(b, '\\n')) }
\t\tif d.Root() < 0 { fmt.Fprintln(os.Stderr, "parse error"); os.Exit(1) }
\t\tos.Stdout.WriteString(d.CstJSON())
\t\treturn
\t}
\t// batch: NUL-separated inputs in, one line per input out — the CST JSON, "-" for an input
\t// the parser rejects, or "!" and the message for a lexer error. One process start for a
\t// whole corpus.
\tif len(os.Args) > 1 && os.Args[1] == "batch" {
\t\tvar b strings.Builder
\t\tfor _, s := range strings.Split(src, "\\x00") {
\t\t\tfunc() {
\t\t\t\tmark := b.Len()
\t\t\t\tdefer func() {
\t\t\t\t\tif r := recover(); r != nil {
\t\t\t\t\t\tle, ok := r.(*LexError)
\t\t\t\t\t\tif !ok { panic(r) }
\t\t\t\t\t\tkept := b.String()[:mark]; b.Reset(); b.WriteString(kept)
\t\t\t\t\t\tb.WriteString("!" + strings.ReplaceAll(le.Msg, "\\n", " ") + "\\n")
\t\t\t\t\t}
\t\t\t\t}()
\t\t\t\tp := &engine{}
\t\t\t\troot := p.parse(s, lex(s))
\t\t\t\tif root < 0 || p.pos != len(p.toks) { b.WriteString("-\\n"); return }
\t\t\t\tp.writeJSON(root, &b); b.WriteByte('\\n')
\t\t\t}()
\t\t}
\t\tos.Stdout.WriteString(b.String())
\t\treturn
\t}
\t// batch-doc: as batch, but each input is typed into an empty Doc (one edit), so the whole text
\t// is parsed from tokens the Doc rebuilds from its metadata — the CST JSON, or "-" when that
\t// Doc rejects. batch-doc-builder: the same through a builder Doc (DocWith), "+" or "-".
\tif len(os.Args) > 1 && (os.Args[1] == "batch-doc" || os.Args[1] == "batch-doc-builder") {
\t\tvar b strings.Builder
\t\tfor _, s := range strings.Split(src, "\\x00") {
\t\t\tfill := []Edit{{Start: 0, End: 0, Text: s}}
\t\t\tif os.Args[1] == "batch-doc" {
\t\t\t\td := NewDoc("")
\t\t\t\td.Edit(fill)
\t\t\t\tif d.Root() < 0 { b.WriteString("-\\n") } else { b.WriteString(d.CstJSON()); b.WriteByte('\\n') }
\t\t\t} else {
\t\t\t\td := newDocWith("", docProbeBuilder{&CstBuilder{}})
\t\t\t\td.Edit(fill)
\t\t\t\tif d.Root() < 0 { b.WriteString("-\\n") } else { b.WriteString("+\\n") }
\t\t\t}
\t\t}
\t\tos.Stdout.WriteString(b.String())
\t\treturn
\t}
\t// lid-of: NUL-separated texts in, one line per text out — lidOf(text), the literal id the Doc
\t// gives a token of that text when it rebuilds the token from its metadata.
\tif len(os.Args) > 1 && os.Args[1] == "lid-of" {
\t\tvar b strings.Builder
\t\tfor _, s := range strings.Split(src, "\\x00") { b.WriteString(strconv.Itoa(int(lidOf(s)))); b.WriteByte('\\n') }
\t\tos.Stdout.WriteString(b.String())
\t\treturn
\t}
\t// batch-tokens: NUL-separated inputs in, one line per input out — the token stream as a JSON
\t// array of [kind, text, newline-before, lid], or "!" and the message for a lexer error.
\tif len(os.Args) > 1 && os.Args[1] == "batch-tokens" {
\t\tvar b strings.Builder
\t\tfor _, s := range strings.Split(src, "\\x00") {
\t\t\ttoks, err := Tokenize(s)
\t\t\tif err != nil { b.WriteString("!" + strings.ReplaceAll(err.Error(), "\\n", " ") + "\\n"); continue }
\t\t\trows := make([][4]interface{}, len(toks))
\t\t\tfor i, t := range toks { rows[i] = [4]interface{}{t.Kind, t.Text, t.Nl, t.Lid} }
\t\t\tj, _ := json.Marshal(rows)
\t\t\tb.Write(j); b.WriteByte('\\n')
\t\t}
\t\tos.Stdout.WriteString(b.String())
\t\treturn
\t}
\tif len(os.Args) > 1 && os.Args[1] == "tok-spans" {
\t\tp := &engine{}
\t\troot := p.parse(src, lex(src))
\t\tif root < 0 || p.pos != len(p.toks) {
\t\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", p.pos, len(p.toks))
\t\t\tos.Exit(1)
\t\t}
\t\tnd := &p.nodes[root]
\t\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\t\tv := p.kids[nd.KidStart+i]
\t\t\tif v < 0 {
\t\t\t\tti, tt := decodeLeaf(v)
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", TT_NAMES[tt], ti, ti+1)
\t\t\t} else {
\t\t\t\tk := &p.nodes[v]
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", RULE_NAMES[k.RuleId], k.TokStart, k.TokEnd)
\t\t\t}
\t\t}
\t\tfmt.Printf("total\\t0\\t%d\\n", p.pos)
\t\treturn
\t}
\tp := &engine{}
\troot := p.parse(src, lex(src))
\tif root < 0 || p.pos != len(p.toks) {
\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", p.pos, len(p.toks))
\t\tos.Exit(1)
\t}
\tvar b strings.Builder
\tp.writeJSON(root, &b)
\tos.Stdout.WriteString(b.String())
}

// The CST builder behind another type, so NewDocWith takes the builder (parserW) Doc.
type docProbeBuilder struct{ *CstBuilder }
`;
  },
});
