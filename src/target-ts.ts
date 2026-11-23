// The TypeScript Target for emit-portable. Renders the language-agnostic ParserIR into a
// self-contained TS parser: a char-class/string/comment lexer, a backtracking recursive-
// descent core, a Pratt expression engine (prefix + binary precedence + mixfix call/member/
// index LEDs), and a CST→JSON printer over stdin. It is the reference rendering — its CST
// is checked byte-for-byte against the interpreter (createParser), so a divergence in the
// portable logic surfaces here before Go/Rust are compiled.
import { type ParserIR, type RdRule, type PrattRule, type NudRef, type Step, type Alt, type Bracket, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type Guard, type Dispatch, type LexFirstBytes, type LexIdPlan, type ReusePlan, type ReusePlanA } from './emit-portable.ts';
import { blockBody, elementTokens, regionKids, portableIR, sepDelimLid, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, lidOf, lidDeltaTable, ctxWordLids, kidOf, lidFlagTable, kidFlagTable, isFirstGuardable, groupByPreserveOrder, tokenSetBits, prattOpTables, stepExpr, stepStmts, ruleShell, prattShell, entryShell, dispatchWalk, gtCompLit, type PortableFacts, type StepLowering, type RuleLowering, type DispatchLowering, type PrattLowering, type CommitLowering } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import type {
  ShapeSpec, ShapeIR, FieldBind, FieldDecl, NodeShape, ChoiceShape, ChoiceArm,
  RuleShape, TokenLeafPolicy, ShapeIRRule, CustomShape, KeepShape,
} from './shape-schema.ts';
import { validateShapeOrThrow } from './shape-validate.ts';
import { defineTarget, type SharedAlgorithms } from './define-target.ts';
import { ATOM, COMPARISON, findAnyName, isOpt, isRec, isRecList, recName, type BinOp, type Lowering, type R, type Ty } from './algo-ir.ts';
import { UNI_ID_CONTINUE, UNI_ID_START } from './uni-ident.ts';
import { type TextUnits, unitLen } from './text-units.ts';

export type { ShapeSpec, ShapeIR } from './shape-schema.ts';

const J = (v: unknown) => JSON.stringify(v);
// TS strings are indexed by UTF-16 code unit: every offset and length printed here is in those units.
const UNITS: TextUnits = 'utf16';
const tlen = (text: string): number => unitLen(text, UNITS);

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.lid === ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kid === ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);
// A longest-match candidate's Guard (emit-portable.ts) over the buffered token t, as conditions;
// keyed: the candidate is reached through its Dispatch key, which already tested the first token.
const guardCond = (g: Guard, t: string, keyed: boolean): string[] =>
  g === null ? [] : [...(keyed || g.first === null ? [] : [`inSet(${g.first.id}, ${t})`]), ...(g.second !== null ? [`secondIn(${g.second.id})`] : []),
    ...g.lead.map((l) => { const inS = l.ctx ? `(inSet(${l.set}, ${t}) || inCtxWords(${t}))` : `inSet(${l.set}, ${t})`; return l.is ? inS : `!${inS}`; })];   // its lead tests (LeadTest) on t
// `if (<conds>) <body>` as one statement (just the body when there is no condition).
const ifTs = (conds: string[], body: string) => (conds.length ? `  if (${conds.join(' && ')}) ${body}` : `  ${body}`);
// A candidate list's Dispatch over the buffered token t: arm(i, keyed) is candidate i's statement.
// nilable: t may be null (no token left), which no key matches.
const dispatchTsL = (t: string): DispatchLowering => ({
  sw: (by, cases) => `  switch (${t}.${by}) {\n${cases.map((c) => `  case ${c.key}:\n${c.arms.join('\n')}\n  break;`).join('\n')}\n  }`,
  nil: (sw) => `  if (${t} !== null) {\n${sw}\n  }`,
});
const dispatchTs = (d: Dispatch, t: string, ids: LexIdPlan, arm: (i: number, keyed: boolean) => string, nilable = false): string =>
  dispatchWalk(d, ids, arm, dispatchTsL(t), nilable);
// A Commit's switch (emit-portable.ts commitWalk) over the buffered token t.
const commitSwTs = (t: string): CommitLowering => ({
  sw: (by, cases, dflt) => `  switch (${t}.${by}) {\n${cases.map((c) => `  ${c.keys.map((k) => `case ${k}:`).join('')}${c.stmt ? `\n${c.stmt}` : ''}${c.ends ? '' : '\n  break;'}`).join('\n')}${dflt ? `\n  default:\n${dflt}` : ''}\n  }`,
  ifAll: ifTs,
  notAll: (conds) => `!(${conds.join(' && ')})`,
  pickDecl: '  let _c = 0;',
  pick: (n) => `{ _c = ${n}; }`,
  picked: (cases) => `  switch (_c) {\n${cases.map((c) => `  case ${c.n}:\n  ${c.stmt}`).join('\n')}\n  }`,
});
// A committed candidate's statement: `body` when conds hold, then `fail` (unless body always returns).
// With no condition the body's block is the statement's own (blockBody).
const commitTs = (conds: string[], body: string, fail: string, returns = false) =>
  `{ ${conds.length ? `if (${conds.join(' && ')}) ${body.startsWith('{') ? body : `{ ${body} }`}` : blockBody(body) ?? body}${conds.length || !returns ? ` ${fail}` : ''} }`;
// Whether candidate i, just ended at pos, beats the best so far: it ends past it, or — a Dispatch
// `ranked` candidate — ties it and was declared earlier. `bi` (the best one's index) is kept only
// in a list that has ranked candidates.
const beatsTs = (d: Dispatch, pos: string, i: number) => d.ranked.includes(i) ? `(${pos} > bestPos || ${pos} === bestPos && ${i} < bi)` : `${pos} > bestPos`;
const markTs = (d: Dispatch, i: number) => (d.ranked.length ? ` bi = ${i};` : '');
const biTs = (d: Dispatch) => (d.ranked.length ? ', bi = -1' : '');
// How a step is printed: 'w' builds through the builder (onto the engine's child stack, see
// engineRuntime), 'r' only recognizes (ParserIR.forms: advances, builds nothing).
type Mode = 'w' | 'r';
// ── The two frames of a construct that may have to undo what it tried ──
// Every one is printed by one of these, so what a frame costs in the output is decided here. The
// checkpoint (position; when building, the child stack's height) and the undo back to it.
const ckptTs = (m: Mode) => `const sp = pos;${m === 'w' ? ' const bk = _n;' : ''}`;
const undoTs = (m: Mode) => `back(sp);${m === 'w' ? ' _n = bk;' : ''}`;
// BRANCH frame: one branch of an ordered choice (`alt`): it returns true from the choice when the
// branch matched, and undoes it when it did not.
const branchTs = (cond: string, m: Mode) => `{ ${ckptTs(m)} if (${cond}) return true; ${undoTs(m)} }`;
// CANDIDATE frame: one candidate of a longest-match list tried from `save`: when it matched and
// beats the best so far, `win` records it; either way the position goes back to `save` for the
// next candidate. Recognized, it has no children, and only its end can win. Building, its children
// go onto the child stack above the best so far (slot `c`); `win` finishes them into one slot
// there and `_keep(b, c)` moves it down to the list's slot `b`, over the best it beat; one that
// loses drops back to `c`.
const candTs = (d: Dispatch, i: number, m: Mode, cond: string, win: string) => m === 'r'
  ? `{ if (${cond} && pos > bestPos) bestPos = pos; back(save); }`
  : `{ const c = _n; if (${cond} && ${beatsTs(d, 'pos', i)}) { ${win} } else _n = c; back(save); }`;
// The typed-AST layer tries an rd rule's alternatives in declaration order, each under its Guard.
const astGuard = (r: RdRule, i: number): string => { const c = guardCond(r.altGuard[i]!, '_ft', false); return c.length ? `_ft !== null && ${c.join(' && ')}` : 'true'; };

/** Emit kid/lid lookup tables into generated lexer source. */
function renderIdTablesTS(ids: LexIdPlan): string {
  const pf = buildLidPrefilter(ids, UNITS);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  return `const KIND_STR: string[] = ${J(ids.kids)};
const _LIDS: string[] = ${J(ids.lids)};
const _KID_MAP = new Map<string, number>(KIND_STR.map((k, i) => [k, i]));
const _LID_MAP = new Map<string, number>(_LIDS.map((t, i) => [t, i]));
const _LID_MAX_LEN = ${pf.maxLen};
const _LID_KW = ${ids.kwLid};
const _LID_FIRST_BITS = new Uint8Array([${bitsLit}]);
function kid_of(kind: string): number { return _KID_MAP.get(kind) ?? 0; }
function lid_of(text: string): number {
  const n = text.length;
  if (n === 0 || n > _LID_MAX_LEN) return 0;
  // No literal has this (length, first unit) key ⇒ lid 0 (the bits hold every literal's key).
  const b0 = text.charCodeAt(0) & 255;
  if ((_LID_FIRST_BITS[n * 32 + (b0 >> 3)]! & (1 << (b0 & 7))) === 0) return 0;
  return _LID_MAP.get(text) ?? 0;
}
function tok_kind(t: Tok): string { return KIND_STR[t.kid]!; }
function tok_text(src: string, t: Tok): string { return src.slice(t.off, t.end); }
function mk_tok(off: number, end: number, nl: boolean, kid: number, lid: number): Tok { return { off, end, nl, kid, lid }; }
`;
}

// The literal id of a token whose text is `text`, given the literals its kind can be
// (shared.tokenLiterals): 0 when it can be none.
const lidCallTs = (lits: string[], text: string): string => (lits.length === 0 ? '0' : `lid_of(${text})`);

// Whether a skipped token's text holds a line terminator (LF, CR, U+2028, U+2029), read in place.
const TS_HAS_LINE_TERM = `function lexHasLineTerm(s: string, a: number, b: number): boolean {
  for (let i = a; i < b; i++) { const c = s.charCodeAt(i); if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return true; }
  return false;
}
`;

// A lexer error (relex-family.ts LexErr): recorded, and the step ends the lex: pos is the end of
// input, so the loop exits (with a type-parameter signature undecided, its head rewinds it).
const tsFail = (kind: string, off: string, end: string): string => `err = { kind: ${kind}, off: ${off}, end: ${end} }; pos = n; continue;`;
const TS_LEX_ERR = `type LexErr = { kind: number; off: number; end: number };
// The message of a lexer error.
function lexError(src: string, e: LexErr): Error {
  return new Error(e.kind === 0 ? 'Unexpected character at offset ' + e.off + ': \\'' + src[e.off] + '\\''
    : e.kind === 1 ? "Invalid identifier escape at offset " + e.off + ": '" + src.slice(e.off, e.end) + "'"
    : e.kind === 2 ? 'Unterminated template literal at offset ' + e.off : 'Invalid escape sequence in template at offset ' + e.off);
}
// The lexer error of a template span (-1 unterminated, -2 - q an invalid escape at q).
function lexTplErr(q: number, n: number): LexErr { return q === -1 ? { kind: 2, off: n, end: 0 } : { kind: 3, off: -2 - q, end: 0 }; }
// The tokens of src; a lexer error throws.
function lex(src: string): Tok[] {
  const [toks, err] = lexAll(src);
  if (err !== null) throw lexError(src, err);
  return toks;
}
`;
const TS_UNEXPECTED = `    ${tsFail('0', 'pos', 'pos')}`;

// One token at a dispatch site: the shared scanner says where it ends; the lexer records it.
function scanTok(ir: ParserIR, t: LexTok, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, identLike: Set<string>): string {
  const name = t.name;
  // `emit(...)` threads the lexer state in stateful mode; a plain push otherwise. A skipped
  // token (comment) still records a newline it spans, so `sameLine` sees it.
  const kid = kidOf(ids, name);
  const push = t.skip
    ? `if (lexHasLineTerm(src, pos, e)) pendingNl = true; `
    : `${stateful ? 'emit' : 'push'}(pos, e, ${kid}, ${lidCallTs(shared.tokenLiterals(ir, t, ids.lids.slice(1)), 'src.slice(pos, e)')}); `;
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (emit-lexer.ts).
  const ext = identLike.has(name) ? 'e = lx_ext(src, e); ' : '';
  // An identifier whose escapes spell no IdentifierName is the lexer error -2 - e (lex-family.ts).
  const escErr = identLike.has(name) ? ` if (e < -1) { ${tsFail('1', 'pos', '-2 - e')} }` : '';
  const scan = `{ let e = ${shared.scanner(name)}(src, pos); if (e >= 0) { ${ext}${push}pos = e; continue; }${escErr} }`;
  return rxTok !== undefined && name === rxTok ? `    if (!prevIsValue()) ${scan}` : `    ${scan}`;
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
// `heads`: per ASCII unit, code that runs first in that unit's arm (and nowhere else), for a test
// only that unit can pass (it tests its own prefix, so an arm shared with other units is safe); a
// unit no candidate starts with gets an arm of its own.
function renderLexByteDispatchTS(codes: string[], firsts: (LexFirstBytes | null)[], indent: string, heads: Map<number, string> = new Map()): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let switchArms = '';
  for (const [unit, code] of heads) if (!arms.some((a) => a.bytes.includes(unit))) switchArms += `${indent}    case ${unit}:\n${code}${indent}      break;\n`;
  for (const arm of arms) {
    switchArms += arm.bytes.map((b) => `${indent}    case ${b}:`).join('\n') + '\n';
    for (const b of arm.bytes) switchArms += heads.get(b) ?? '';
    switchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
    switchArms += `${indent}      break;\n`;
  }
  return `${indent}if (c >= 128) {
${fallback}
${indent}} else {
${indent}  switch (c) {
${switchArms}${indent}  }
${indent}}`;
}

// Newline mode: every line break outside flow delimiters is a NEWLINE token spanning the break.
function newlineParts(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; table: string; ws: string; hooks: string } {
  return {
    state: `  let flowDepth = 0;
`,
    stateFrom: '',
    table: `const _FLOW_D: number[] = [${lidDeltaTable(ids, nl.flowOpen, nl.flowClose).join(', ')}];
`,
    ws: `    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      pos++;
      for (let d = src.charCodeAt(pos); d === 32 || d === 9 || d === 11 || d === 12 || d === 160 || d === 5760 || (d >= 8192 && d <= 8202) || d === 8239 || d === 8287 || d === 12288 || d === 65279; d = src.charCodeAt(pos)) pos++;
      continue;
    }
    if (c === 10 || c === 13) {   // LF/CR only — LS/PS fall through to the unexpected-character throw, matching the interpreter
      const s = pos;
      pos++; if (c === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
      if (flowDepth === 0) ${pushFn}(s, pos, ${kidOf(ids, nl.token)}, 0);
      pendingNl = true;
      continue;
    }
`,
    hooks: `    if (kid === 0) { const d = _FLOW_D[lid]!; if (d !== 0) flowDepth = Math.max(0, flowDepth + d); }
`,
  };
}

// The lexer of a grammar with an element region (ElementPlan): the frame stack is the template
// stack, and the frame decisions are the shared family's (lex-family.ts elementFns); what is here
// is their placement in the dispatch loop, the token push, and the type-parameter signature's
// speculation (lexed as code to its verdict, then rewound: docs/REGIONS.md).
function elementLexerTS(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms, p: {
  scans: string; consts: string; rxStateFrom: string; nlWs: string; lexCodes: string[]; lexFirsts: (LexFirstBytes | null)[];
  tplCloseTest: string; tplOpenTest: string; uniIdentFallbackTs: string;
}): string {
  const el = ir.elements!, rx = ir.regexCtx, tpl = ir.tpl, sig = el.signature, raw = el.rawText.length > 0;
  const operand = el.entry === 'operand';
  if (operand && !rx) throw new Error('portable: an operand element entry needs the regex context (prevIsValue)');
  const L = tlen(el.tagOpen);
  const consts = `${p.consts}const LID_EL_OPEN = ${lidOf(ids, el.tagOpen)};
const LID_EL_CLOSE = ${lidOf(ids, el.tagClose)};
const LID_HOLE_OPEN = ${lidOf(ids, el.holeOpen)};
const LID_HOLE_CLOSE = ${lidOf(ids, el.holeClose)};
const LID_EQ = ${lidOf(ids, '=')};
${sig ? `${tsFlagTable('_elThen', lidFlagTable(ids, sig.then))}\n` : ''}`;
  // prevIsValue: in a tag nothing is a regex; the token that ended an element is a value.
  const prevIsValue = p.rxStateFrom.replace('function prevIsValue(): boolean {\n', `function prevIsValue(): boolean {
    if (templateStack.length > 0) { const f = templateStack[templateStack.length - 1]; if ((f & 3) === 2 && (f & 12) !== 0) return true; }
    if (elEnded) return true;
`);
  const rxParams = rx ? 'prevLid: number, prevKid: number, bpLid: number, hasPrev: boolean, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, ' : '';
  const rxRet = rx ? 'prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean; ' : '';
  const rxNames = rx ? 'prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, ' : '';
  const rxInit = rx ? '0, 0, 0, false, false, [], false, false, ' : '';
  // Brace counting in the holes (kind 0 template, 1 element hole; step 4): a `{` deepens, a `}`
  // at a count above 0 shallows; at 0 the closer is lexed by its own test.
  const braces = [
    tpl ? `if ((f & 3) === 0) { if (lid === LID_BRACE_OPEN) templateStack[templateStack.length - 1] = f + 4; else if (lid === LID_INTERP_CLOSE) templateStack[templateStack.length - 1] = f - 4; }` : '',
    `if ((f & 3) === 1) { if (lid === LID_HOLE_OPEN) templateStack[templateStack.length - 1] = f + 4; else if (lid === LID_HOLE_CLOSE) templateStack[templateStack.length - 1] = f - 4; }`,
  ].filter(Boolean).join(' else ');
  const specState = sig ? `  // A type-parameter signature being decided: the token index of its tagOpen (-1: none), the
  // state before it, how it was decided (a lexer error decides it: the head was an element), and
  // the decision kept for the tagOpen it rewinds to.
  let specTok = -1, specBase = 0, specClosedAt = -1, specDone = false, specThen = false, specOff = 0, specEnd = 0;
  let specAt = -1, specKeep = false;
  let svPos = 0, svNl = false, svPrevLid = 0, svPrevKid = 0, svBpLid = 0, svHasPrev = false, svHasPrev2 = false, svLastClose = false, svLastBang = false, svElEnded = false, svAngle = 0;
  const svParen: boolean[] = [], svStack: number[] = [];
  function specRewind(): void {
    const keep = specDone && err === null && specThen;
    const re = specDone && err === null ? ${shared.elementFn('reach')}(src, specEnd) : n + 1;
    if (re > laEnd) laEnd = re;
    if (keep) specUntil = specOff;
    specAt = svPos; specKeep = keep;
    toks.length = specTok;
    pos = svPos; pendingNl = svNl; prevLid = svPrevLid; prevKid = svPrevKid; bpLid = svBpLid; hasPrev = svHasPrev; hasPrev2 = svHasPrev2;
    lastClose = svLastClose; lastBang = svLastBang; elEnded = svElEnded; tagAngle = svAngle;
    parenHead.length = 0; for (const b of svParen) parenHead.push(b);
    templateStack.length = 0; for (const f of svStack) templateStack.push(f);
    specTok = -1; specClosedAt = -1; specDone = false; err = null;
  }
` : '';
  const emitFn = `  function emit(off: number, end: number, kid: number, lid: number): void {
${rx ? `    if (lid === LID_LPAREN) { const isMember = hasPrev2 && !!_mem[bpLid]; parenHead.push(!isMember && prevKid === KID_IDENT && !!_phK[prevLid]); }
    else if (lid === LID_RPAREN) { lastClose = parenHead.pop() ?? false;${sig ? ' if (specTok >= 0 && toks.length > specTok + 3 && parenHead.length === specBase) specClosedAt = toks.length;' : ''} }
    if (_pav[lid]) lastBang = prevIsValue();
` : ''}${sig ? `    // the token after the signature group's closer decides it (a closer that leaves the bracket
    // stack at its base, even by popping an empty one, closes it again)
    if (specClosedAt >= 0 && toks.length > specClosedAt) { specClosedAt = -1; specDone = true; specThen = kid === 0 && _elThen[lid] === 1; specOff = off; specEnd = end; }
` : ''}    if (templateStack.length > 0) { const f = templateStack[templateStack.length - 1]; ${braces} }
    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false; elEnded = false;${rx ? '\n    bpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true;' : ''}
  }
`;
  // The entry from code, in the tagOpen unit's dispatch arm (outside element frames: inside one
  // the frame step lexes every tagOpen).
  const enter = `      templateStack.push(6); emit(pos, pos + ${L}, 0, LID_EL_OPEN);${raw ? ' tagAt.push(toks.length - 1);' : ''} tagAngle = 0; pos += ${L}; continue;\n`;
  const entry = !operand ? `    if (src.startsWith(${J(el.tagOpen)}, pos)) {\n${enter}    }\n`
    : !(el.head || sig) ? `    if (src.startsWith(${J(el.tagOpen)}, pos) && !prevIsValue()) {\n${enter}    }\n`
    : `    if (src.startsWith(${J(el.tagOpen)}, pos)${sig ? ' && specTok < 0 && pos >= specUntil' : ''} && !prevIsValue()) {
      let op: number;
      ${sig ? 'if (pos === specAt) { op = specKeep ? 0 : 1; specAt = -1; } else ' : ''}{ const [o, re] = ${shared.elementFn('opens')}(src, pos); op = o; if (re > laEnd) laEnd = re; }
      if (op === 1) {
${enter}      }
${sig ? `      if (op === 2) {
        svPos = pos; svNl = pendingNl; svPrevLid = prevLid; svPrevKid = prevKid; svBpLid = bpLid; svHasPrev = hasPrev; svHasPrev2 = hasPrev2;
        svLastClose = lastClose; svLastBang = lastBang; svElEnded = elEnded; svAngle = tagAngle;
        svParen.length = 0; for (const b of parenHead) svParen.push(b);
        svStack.length = 0; for (const f of templateStack) svStack.push(f);
        specTok = toks.length; specBase = parenHead.length; specClosedAt = -1; specDone = false;
      }
` : ''}    }
`;
  // An element hole's closer at brace count 0 ends it (the closer is lexed inside the frame).
  const holeClose = `    if (templateStack.length > 0 && templateStack[templateStack.length - 1] === 1 && src.startsWith(${J(el.holeClose)}, pos)) {
      emit(pos, pos + ${tlen(el.holeClose)}, 0, LID_HOLE_CLOSE); templateStack.pop(); pos += ${tlen(el.holeClose)}; continue;
    }
`;
  const heads = new Map<number, string>();
  const headUnit = (t: string) => { const u = t.charCodeAt(0); return u < 128 && ![9, 10, 11, 12, 13, 32].includes(u) ? u : null; };
  let pre = '';
  const place = (lit: string, code: string) => { const u = headUnit(lit); if (u === null) pre += code; else heads.set(u, (heads.get(u) ?? '') + code); };
  place(el.tagOpen, entry);
  place(el.holeClose, holeClose);
  if (tpl) { place(tpl.interpClose, p.tplCloseTest); place(tpl.open, p.tplOpenTest); }
  const cascade = renderLexByteDispatchTS(p.lexCodes, p.lexFirsts, '    ', heads);
  const frameStep = `    if (templateStack.length > 0 && (templateStack[templateStack.length - 1] & 3) === 2) {
      const fr = templateStack[templateStack.length - 1];
      const [fe, fk, fl, ft, fp, fa, fla] = ${shared.elementFn('frame')}(src, pos, fr, tagAngle, toks.length > 0 && toks[toks.length - 1].lid === LID_EQ, laEnd);
      laEnd = fla;
      if (fe >= 0) {
        emit(pos, fe, fk, fl);
${raw ? `        // each element frame's current tag: the index of its tagOpen token (the name is the next)
        if (fl === LID_EL_OPEN) { if (fp === 6) tagAt.push(toks.length - 1); else if (((fr >> 2) & 3) === 0) tagAt[tagAt.length - 1] = toks.length - 1; }
` : ''}        if (ft < 0) { templateStack.pop();${raw ? ' tagAt.pop();' : ''} elEnded = true; } else templateStack[templateStack.length - 1] = ft;
        if (fp !== 0) templateStack.push(fp);
${raw ? `        // an open tag ended: a raw-text name gives its body to a raw frame (kind 3), lexed next
        if (fl === LID_EL_CLOSE && ((fr >> 2) & 3) === 1 && tagAngle === 0) {
          const i = tagAt[tagAt.length - 1] + 1;
          if (i < toks.length - 1) { const [re, rk] = ${shared.elementFn('raw')}(src, toks[i].off, toks[i].end, fe); if (rk !== 0 && re > fe) templateStack.push(3); }
        }
` : ''}        tagAngle = fa; pos = fe; continue;
      }
    }
${raw ? `    if (templateStack.length > 0 && templateStack[templateStack.length - 1] === 3) {
      const i = tagAt[tagAt.length - 1] + 1;
      const [re, rk] = ${shared.elementFn('raw')}(src, toks[i].off, toks[i].end, pos);
      emit(pos, re, rk, 0); templateStack.pop(); pos = re; continue;
    }
` : ''}`;
  const loopBody = `${sig ? '    if (specTok >= 0 && (specDone || err !== null || pos >= n)) { specRewind(); continue; }\n' : ''}    const c = src.charCodeAt(pos);
${frameStep}${p.nlWs}${pre}${cascade}
${p.uniIdentFallbackTs}${TS_UNEXPECTED}`;
  const loop = `  while (${sig ? '(pos < n || specTok >= 0) && (limit === undefined || toks.length - base < limit || specTok >= 0)' : 'pos < n && (limit === undefined || toks.length - base < limit)'}) {
${loopBody}
  }`;
  return `${consts}${p.scans}function lexFrom(src: string, pos: number, pendingNl: boolean, ${rxParams}templateStack: number[], elEnded: boolean, tagAngle: number, laEnd: number, specUntil: number, ${raw ? 'tagAt: number[], ' : ''}toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; ${rxRet}templateStack: number[]; elEnded: boolean; tagAngle: number; laEnd: number; specUntil: number${raw ? '; tagAt: number[]' : ''}; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${prevIsValue}${specState}${emitFn}${loop}
  return { pos, pendingNl, ${rxNames}templateStack, elEnded, tagAngle, laEnd, specUntil${raw ? ', tagAt' : ''}, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, ${rxInit}[], false, 0, 0, 0, ${raw ? '[], ' : ''}toks).err];
}`;
}

/** Emit a dense 0/1 number[] bit table (indexed by lid or kid). */
function tsFlagTable(name: string, flags: boolean[]): string {
  return `const ${name}: number[] = [${flags.map((b) => (b ? 1 : 0)).join(', ')}];`;
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
  const pushFn = stateful ? 'emit' : 'push';
  const punctLine = (p: string) =>
    `    if (src.startsWith(${J(p)}, pos)) { ${pushFn}(pos, pos + ${tlen(p)}, 0, ${lidOf(ids, p)}); pos += ${tlen(p)}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, shared, stateful, ids, rx?.regexToken, punctLine);
  const rxBitTables = rx ? `${tsFlagTable('_divT', lidFlagTable(ids, rx.divisionTexts))}
${tsFlagTable('_divK', kidFlagTable(ids, rx.divisionTypes))}
${tsFlagTable('_rxT', lidFlagTable(ids, rx.regexTexts))}
${tsFlagTable('_phK', lidFlagTable(ids, rx.parenHeadKw))}
${tsFlagTable('_mem', lidFlagTable(ids, rx.memberAccess))}
${tsFlagTable('_pav', lidFlagTable(ids, rx.postfixAfterValue))}
const KID_IDENT = ${kidOf(ids, rx.identToken)};
const LID_LPAREN = ${lidOf(ids, '(')};
const LID_RPAREN = ${lidOf(ids, ')')};
` : '';
  const tplLidConsts = tpl ? `const LID_BRACE_OPEN = ${lidOf(ids, tpl.braceOpen)};
const LID_INTERP_CLOSE = ${lidOf(ids, tpl.interpClose)};
` : '';
  const rxModuleConsts = `${rxBitTables}${tplLidConsts}`;
  // Per-feature pieces of the shared `emit`, so a grammar can have regex, templates, or both.
  const rxState = rx ? `  let prevLid = 0, prevKid = 0, bpLid = 0, hasPrev = false, hasPrev2 = false;
  const parenHead: boolean[] = [];
  let lastClose = false, lastBang = false;
  function prevIsValue(): boolean {
    if (!hasPrev) return false;
    if (_pav[prevLid]) return lastBang;
    const isExprKw = prevKid === KID_IDENT && !!_rxT[prevLid] && !(hasPrev2 && !!_mem[bpLid]);
    const isParenHead = prevLid === LID_RPAREN && lastClose;
    return !isExprKw && !isParenHead && (!!_divK[prevKid] || !!_divT[prevLid]);
  }
` : '';
  const tplState = tpl ? `  const templateStack: number[] = [];
` : '';
  const emitHooks = [
    rx ? `    if (lid === LID_LPAREN) { const isMember = hasPrev2 && !!_mem[bpLid]; parenHead.push(!isMember && prevKid === KID_IDENT && !!_phK[prevLid]); }
    else if (lid === LID_RPAREN) { lastClose = parenHead.pop() ?? false; }
    if (_pav[lid]) lastBang = prevIsValue();` : '',
    tpl ? `    if (templateStack.length > 0) { if (lid === LID_BRACE_OPEN) templateStack[templateStack.length - 1]++; else if (lid === LID_INTERP_CLOSE) templateStack[templateStack.length - 1]--; }` : '',
    nl ? newlineParts(nl, 'emit', ids).hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n    bpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true;` : '';
  const emitFn = stateful ? `  function emit(off: number, end: number, kid: number, lid: number): void {
${emitHooks}
    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false;${emitTail}
  }
` : '';
  const rxStateFrom = rx ? `  function prevIsValue(): boolean {
    if (!hasPrev) return false;
    if (_pav[prevLid]) return lastBang;
    const isExprKw = prevKid === KID_IDENT && !!_rxT[prevLid] && !(hasPrev2 && !!_mem[bpLid]);
    const isParenHead = prevLid === LID_RPAREN && lastClose;
    return !isExprKw && !isParenHead && (!!_divK[prevKid] || !!_divT[prevLid]);
  }
` : '';
  const emitRxOnly = rx ? `  function emit(off: number, end: number, kid: number, lid: number): void {
    if (lid === LID_LPAREN) { const isMember = hasPrev2 && !!_mem[bpLid]; parenHead.push(!isMember && prevKid === KID_IDENT && !!_phK[prevLid]); }
    else if (lid === LID_RPAREN) { lastClose = parenHead.pop() ?? false; }
    if (_pav[lid]) lastBang = prevIsValue();
    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false;
    bpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true;
  }
` : '';
  const emitTplOnly = tpl ? `  function emit(off: number, end: number, kid: number, lid: number): void {
    if (templateStack.length > 0) { if (lid === LID_BRACE_OPEN) templateStack[templateStack.length - 1]++; else if (lid === LID_INTERP_CLOSE) templateStack[templateStack.length - 1]--; }
    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false;
  }
` : '';
  const emitRxTpl = (rx && tpl) ? `  function emit(off: number, end: number, kid: number, lid: number): void {
    if (lid === LID_LPAREN) { const isMember = hasPrev2 && !!_mem[bpLid]; parenHead.push(!isMember && prevKid === KID_IDENT && !!_phK[prevLid]); }
    else if (lid === LID_RPAREN) { lastClose = parenHead.pop() ?? false; }
    if (_pav[lid]) lastBang = prevIsValue();
    if (templateStack.length > 0) { if (lid === LID_BRACE_OPEN) templateStack[templateStack.length - 1]++; else if (lid === LID_INTERP_CLOSE) templateStack[templateStack.length - 1]--; }
    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false;
    bpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true;
  }
` : '';
  // The template tests can pass only at their delimiter's first unit: when that unit is ASCII
  // (and not whitespace, which is consumed before the dispatch) the test is made in that unit's
  // dispatch arm, before the arm's own candidates, not in every round.
  const tplHeads = new Map<number, string>();
  const tplLits = shared.templateLiterals(ir, ids.lids.slice(1));
  const headUnit = (t: string) => { const u = t.charCodeAt(0); return u < 128 && ![9, 10, 11, 12, 13, 32].includes(u) ? u : null; };
  // The span itself is the shared family's scanner; this reads which delimiter ended it (or its
  // lexer error).
  const tplSpanTs = (from: string, strict: string): string => `      const q = ${shared.tplSpan()}(src, ${from}, ${strict});
      if (q < 0) { err = lexTplErr(q, n); pos = n; continue; }
      const interp = src.startsWith(${J(tpl!.interpOpen)}, q), e = interp ? q + ${tlen(tpl!.interpOpen)} : q + ${tlen(tpl!.open)};
`;
  const tplCloseTest = tpl ? `    if (templateStack.length > 0 && src.startsWith(${J(tpl.interpClose)}, pos) && templateStack[templateStack.length - 1] === 0) {
      templateStack.pop();
${tplSpanTs('pos + ' + tlen(tpl.interpClose), 'false')}      if (interp) { emit(pos, e, ${kidOf(ids, '$templateMiddle')}, ${lidCallTs(tplLits.middle, 'src.slice(pos, e)')}); templateStack.push(0); }
      else { emit(pos, e, ${kidOf(ids, '$templateTail')}, ${lidCallTs(tplLits.tail, 'src.slice(pos, e)')}); }
      pos = e; continue;
    }
` : '';
  const tplOpenTest = tpl ? `    if (src.startsWith(${J(tpl.open)}, pos)) {
${tplSpanTs('pos + ' + tlen(tpl.open), rx ? '!prevIsValue()' : 'true')}      if (interp) { emit(pos, e, ${kidOf(ids, '$templateHead')}, ${lidCallTs(tplLits.head, 'src.slice(pos, e)')}); templateStack.push(0); }
      else { emit(pos, e, ${kidOf(ids, tpl.token)}, ${lidCallTs(tplLits.whole, 'src.slice(pos, e)')}); }
      pos = e; continue;
    }
` : '';
  let tplDispatch = '';
  if (tpl) for (const [t, code] of [[tpl.interpClose, tplCloseTest], [tpl.open, tplOpenTest]] as const) {
    const hu = headUnit(t);
    // Two tests at one unit keep their order; once one stays here, the next stays too.
    if (hu !== null && tplDispatch === '') tplHeads.set(hu, (tplHeads.get(hu) ?? '') + code);
    else tplDispatch += code;
  }
  const cascade = renderLexByteDispatchTS(lexCodes, lexFirsts, '    ', tplHeads);
  const identNameTs = ir.identToken;
  const identKidTs = identNameTs ? kidOf(ids, identNameTs) : 0;
  const lxExtConst = ir.identLike.length
    ? `const LX_UNI_CONT = /${UNI_ID_CONTINUE}+/uy;
function lx_ext(src: string, e: number): number {
  if (e >= src.length || src.charCodeAt(e) < 0x80) return e;
  LX_UNI_CONT.lastIndex = e;
  const m = LX_UNI_CONT.exec(src);
  return m ? e + m[0].length : e;
}
// JavaScript has the classes natively (uni-ident.ts).
const LX_ID_START = /^${UNI_ID_START}$/u, LX_ID_PART = /^${UNI_ID_CONTINUE}$/u;
function ${shared.uniClass()}(cp: number): number {
  const ch = String.fromCodePoint(cp);
  return LX_ID_START.test(ch) ? 2 : LX_ID_PART.test(ch) ? 1 : 0;
}
`
    : '';
  const lxUniIdentConst = (nl ? newlineParts(nl, 'emit', ids).table : '') + (shared.scannedTokens(ir).some((t) => t.skip) ? TS_HAS_LINE_TERM : '') + (identNameTs
    ? `const LX_UNI_IDENT = /${UNI_ID_START}${UNI_ID_CONTINUE}*/uy;\n`
    : '') + lxExtConst;
  const uniIdentPushTs = stateful ? 'emit' : 'push';
  const uniIdentFallbackTs = identNameTs
    ? `    LX_UNI_IDENT.lastIndex = pos;
    const _um = LX_UNI_IDENT.exec(src);
    if (_um) { ${uniIdentPushTs}(pos, pos + _um[0].length, ${identKidTs}, lid_of(_um[0])); pos += _um[0].length; continue; }
`
    : '';
  const nlState = nl ? newlineParts(nl, stateful ? 'emit' : 'push', ids).state : '';
  const nlStateFrom = nl ? newlineParts(nl, 'push', ids).stateFrom : '';
  // A whitespace run is consumed in one dispatch round (see the Rust target): per unit only "is it
  // still whitespace"; a run after a line terminator also takes further terminators.
  const isWs = (v: string) => `${v} === 32 || ${v} === 9 || ${v} === 11 || ${v} === 12 || ${v} === 160 || ${v} === 5760 || (${v} >= 8192 && ${v} <= 8202) || ${v} === 8239 || ${v} === 8287 || ${v} === 12288 || ${v} === 65279`;
  const isNl = (v: string) => `${v} === 10 || ${v} === 13 || ${v} === 8232 || ${v} === 8233`;
  const nlWs = nl ? newlineParts(nl, stateful ? 'emit' : 'push', ids).ws : `    if (${isNl('c')}) {
      pendingNl = true; pos++;
      for (let d = src.charCodeAt(pos); ${isWs('d')} || ${isNl('d')}; d = src.charCodeAt(pos)) pos++;
      continue;
    }
    if (${isWs('c')}) {
      pos++;
      for (let d = src.charCodeAt(pos); ${isWs('d')}; d = src.charCodeAt(pos)) pos++;
      continue;
    }
`;
  const pushHooks = nl && !stateful ? newlineParts(nl, 'push', ids).hooks : '';
  const pushFnDef = stateful ? '' : nl
    ? `  const push = (off: number, end: number, kid: number, lid: number) => {
${pushHooks}    toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false;
  };
`
    : '  const push = (off: number, end: number, kid: number, lid: number) => { toks.push(mk_tok(off, end, pendingNl, kid, lid)); pendingNl = false; };\n';
  const loopBody = `    const c = src.charCodeAt(pos);
    // JS line terminators LF/CR/LS/PS set newline-before, matching the interpreter (emit-lexer.ts).
${nlWs}${tplDispatch}${cascade}
${uniIdentFallbackTs}${TS_UNEXPECTED}`;
  if (el) return elementLexerTS(ir, ids, shared, { scans, consts: `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}`, rxStateFrom, nlWs, lexCodes, lexFirsts, tplCloseTest, tplOpenTest, uniIdentFallbackTs });
  if (rxOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, bpLid: number, hasPrev: boolean, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${rxStateFrom}${emitRxOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, 0, 0, 0, false, false, [], false, false, toks).err];
}`;
  }
  if (tplOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; templateStack: number[]; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${emitTplOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, templateStack, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, [], toks).err];
}`;
  }
  if (rxTpl) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, bpLid: number, hasPrev: boolean, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean; templateStack: number[]; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${rxStateFrom}${emitRxTpl}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, 0, 0, 0, false, false, [], false, false, [], toks).err];
}`;
  }
  if (rxOrTpl) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  const n = src.length;
  let pos = 0;
  let pendingNl = false;
  let err: LexErr | null = null;
${rxState}${tplState}${nlState}${emitFn}  while (pos < n) {
${loopBody}
  }
  return [toks, err];
}`;
  }
  if (newlineOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, flowDepth: number, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; flowDepth: number; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${nlStateFrom}${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, flowDepth, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, 0, toks).err];
}`;
  }
  return `${renderIdTablesTS(ids)}${lxUniIdentConst}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; err: LexErr | null } {
  const n = src.length;
  const base = toks.length;
  let err: LexErr | null = null;
${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, err };
}
function lexAll(src: string): [Tok[], LexErr | null] {
  const toks: Tok[] = [];
  return [toks, lexFrom(src, 0, false, toks).err];
}`;
}

// Lifted steps. A step printed as a function — the body of a star / opt / sep, an `alt`, `suppress`,
// `ctx` or `sameLine` step — reads no local of the function around its site (its state is the
// cursor and the child stack), so it is one module-level function, printed once per distinct body,
// instead of a closure allocated at every evaluation of its site. Per emit (keyed by its id plan):
// liftedFns prints them all.
const LIFTED = new WeakMap<LexIdPlan, Map<string, string>>();
function lift(ids: LexIdPlan, body: string): string {
  let m = LIFTED.get(ids);
  if (m === undefined) LIFTED.set(ids, (m = new Map()));
  let name = m.get(body);
  if (name === undefined) m.set(body, (name = `step${m.size}`));
  return name;
}
function liftedFns(ids: LexIdPlan): string {
  return [...(LIFTED.get(ids) ?? new Map<string, string>())].map(([body, name]) => `function ${name}(): boolean { ${body} }\n`).join('')
    + [...(CONSTS.get(ids) ?? new Map<string, string>())].map(([lit, name]) => `const ${name} = ${lit};\n`).join('');
}
// An array a step tests against (an inline alternation's literals, a led's left-leaf words) is a
// module constant, each distinct one once: an array literal at its site would be allocated at every
// call. (Go passes a slice literal that does not escape and Rust a promoted `&[..]`: neither allocates.)
const CONSTS = new WeakMap<LexIdPlan, Map<string, string>>();
function liftConst(ids: LexIdPlan, lit: string): string {
  let m = CONSTS.get(ids);
  if (m === undefined) CONSTS.set(ids, (m = new Map()));
  let name = m.get(lit);
  if (name === undefined) m.set(lit, (name = `_arr${m.size}`));
  return name;
}
// The step walk's TS spelling (emit-portable.ts, StepLowering), building ('w': children onto the
// child stack) or recognizing ('r': nothing built). TS: a body or a step's statements are a lifted
// module-level function (lift), so no closure is allocated where it runs.
const SUFFIX: Record<Mode, string> = { w: 'W', r: 'R' };
function tsSteps(ids: LexIdPlan, m: Mode): StepLowering {
  const S = SUFFIX[m];
  const fn = (cond: string) => lift(ids, `return ${cond};`);
  const L: StepLowering = {
    inner: () => L,
    shared: (id) => `sub${id}${S}()`,
    lit: (s) => (gtCompLit(ids, s) ? `_matchComp(${lidOf(ids, s.value)})` : `matchLit${S}(${lidOf(ids, s.value)})`),
    tok: (name) => `matchTok${S}(${kidOf(ids, name)})`,
    // Recognized, an interpolated template runs its building matcher and its node is dropped.
    template: (name, hole) => `(matchTok${S}(${kidOf(ids, name)}) || ${m === 'r' ? `_drop(_n, matchTemplateW(parse${hole}W))` : `matchTemplateW(parse${hole}W)`})`,
    rule: (name) => `parse${name}${S}()`,
    // Recognized, a Pratt rule runs its building form and its node is dropped (ParserIR.forms).
    ruleBp: (name, bp) => (m === 'r' ? `_drop(_n, ${name}_bpW(${bp}))` : `${name}_bpW(${bp})`),
    // A body guard (emit-portable.ts annotateSteps): opt / sep test it before their one attempt,
    // star before each attempt, so a refused attempt takes no mark. A clean body (Step.clean) is
    // attempted without a mark (starC / sepByC; an opt's attempt is the body itself).
    star: (body, g, c) => (g === null ? `star${c ? 'C' : S}(${fn(body)})` : `starIn${c ? 'C' : S}(${g}, ${fn(body)})`),
    opt: (body, g, c) => {
      const attempt = c ? `${body} || true` : `opt${S}(${fn(body)})`;
      return g === null ? (c ? `(${attempt})` : attempt) : `(!ahead(${g}, true) || ${attempt})`;
    },
    sep: (elem, delim, g, c) => {
      const call = `sepBy${c ? 'C' : ''}${S}(${fn(elem)}, ${sepDelimLid(ids, delim)})`;
      return g === null ? call : `(!ahead(${g}, true) || ${call})`;
    },
    altlit: (values) => `altLit${S}(${liftConst(ids, `[${values.map((v) => lidOf(ids, v)).join(', ')}]`)})`,
    look: (id, is) => `${is ? '' : '!'}look${id}()`,
    ahead: (set, is) => `ahead(${set}, ${is})`,
    aheadCtx: (set, is) => (is ? `(ahead(${set}, true) || ctxWord())` : `(ahead(${set}, false) && !ctxWord())`),
    sameLine: () => `${lift(ids, 'const t = peek(); return t !== null && !t.nl;')}()`,
    inPlace: (_kind, stmts) => `${lift(ids, stmts)}()`,
    ret: (cond) => `return ${cond};`,
    suppress: (set, cond) => `_suppressNext = ${set}; const _r = (${cond}); _suppressNext = 0; return _r;`,
    ctx: (ctx, cond) => `const _c = _ctx; _ctx = ${ctx}; const _r = (${cond}); _ctx = _c; return _r;`,
    // A branch that fails clean (Step.clean) has nothing to undo: no frame.
    branch: (cond, clean) => (clean ? `{ if (${cond}) return true; }` : branchTs(cond, m)),
    guarded: (first, branch) => `if (_ft !== null && ${firstCond(first, '_ft', ids)}) ${branch}`,
    choice: (peek, tries) => `${peek ? 'const _ft = peek(); ' : ''}${tries.join(' ')} return false;`,
    predictive: (arms) => `const t = peek(); if (t === null) return false; ${arms.map((a) => `if (${firstCond(a.first, 't', ids)}) ${a.branch}`).join(' else ')} return false;`,
  };
  return L;
}
const stepCond = (s: Step, ids: LexIdPlan, m: Mode): string => stepExpr(s, tsSteps(ids, m));

// ParserIR.lookaheads, one function each, in recognize form (ParserIR.forms): whether the body
// matches here; it undoes the position (a Pratt rule it runs leaves nothing behind: its node is
// dropped).
function lookFns(ir: ParserIR, ids: LexIdPlan): string {
  return ir.lookaheads.map((body, id) => `function look${id}(): boolean { ${ckptTs('r')} const m = ${body.map((x) => stepCond(x, ids, 'r')).join(' && ')}; ${undoTs('r')} return m; }\n`).join('');
}

// ParserIR.shared, one function per form it is printed in (ParserIR.forms): the step, run against
// the caller's children (building: the child stack; recognized, none). It undoes nothing: a failed
// step leaves what it advanced and appended for the construct around its site to undo, as the
// inlined step did.
function sharedFns(ir: ParserIR, ids: LexIdPlan, m: Mode): string {
  const has = m === 'r' ? ir.forms.recognizeShared : ir.forms.buildShared;
  return ir.shared.map((s, id) => (has[id] ? `function sub${id}${SUFFIX[m]}(): boolean { ${stepStmts(s, tsSteps(ids, m))} }\n` : '')).join('');
}

// A rule in recognize form (ParserIR.forms): whether it matches here, advancing past it. An rd
// rule has rdRuleW's control flow building nothing: its longest match compares end positions only
// (a tie only chooses which node, and none is built). A Pratt rule runs its building form and
// drops the node.
function ruleR(r: RdRule | PrattRule, ids: LexIdPlan): string {
  if (r.kind === 'pratt') return `function parse${r.name}R(): boolean { return _drop(_n, parse${r.name}W()); }`;
  return ruleShell(r, ids, tsRules(r, ids, 'r'));
}

/** An rd rule in building form, over the child stack. It returns whether it matched;
 *  matched, its node is the one slot it left on the stack (at the height `b` it found), else the
 *  stack is back at `b`. */
function rdRuleW(r: RdRule, ids: LexIdPlan): string {
  return ruleShell(r, ids, tsRules(r, ids, 'w'));
}

// The TS spelling of an rd rule's shell (emit-portable.ts, ruleShell) in form m: building ('w')
// keeps the child stack's height `b` beside the position and finishes the node (finR); a candidate
// that wins is moved down to `b` over the best it beat (candTs).
function tsRules(r: RdRule, ids: LexIdPlan, m: Mode): RuleLowering {
  const cn = J(r.name), w = m === 'w';
  return {
    steps: tsSteps(ids, m),
    fn: (lines) => `function parse${r.name}${w ? 'W' : 'R'}(): boolean {\n${lines.join('\n')}\n}`,
    ind: '  ',
    ifThen: (test, then) => `if (${test}) ${then}`,
    first: (f) => firstCond(f, 't', ids),
    accept: () => (w ? `{ finR(${cn}, b, save); return true; }` : 'return true;'),
    open: () => (w ? '  const save = pos, b = _n;' : '  const save = pos;'),
    peekOrFail: '  const t = peek(); if (t === null) return false;',
    armJoin: ' ',
    fail: (clean) => (w ? (clean ? '  return false;' : '  back(save); _n = b;\n  return false;') : '  back(save);\n  return false;'),
    openBest: (d) => (w ? `  const save = pos, b = _n;\n  let bestPos = save${biTs(d)};` : '  const save = pos;\n  let bestPos = save;'),
    peekOpt: '  const _ft = peek();',
    cand: (d, i, cond) => candTs(d, i, m, cond, `finR(${cn}, c, save); _keep(b, c); bestPos = pos;${markTs(d, i)}`),
    guard: (g, keyed, stmt) => { const c = guardCond(g, '_ft', keyed); return ifTs(c.length && !keyed ? ['_ft !== null', ...c] : c, stmt); },
    dispatch: dispatchTsL('_ft'),
    closeBest: w ? '  pos = bestPos;\n  return _n !== b;' : '  pos = bestPos;\n  return bestPos > save;',
    commitPeek: '  const _ft = peek();',
    guardConds: (g) => guardCond(g, '_ft', false),
    commit: (_i, conds, cond, undo, nullable) => commitTs(conds, w
      ? `{ const s = pos, b = _n; if (${cond}${nullable ? ' && pos > s' : ''}) { finR(${cn}, b, s); return true; }${undo ? ' back(s); _n = b;' : ''} }`
      : `{ ${undo ? 'const s = pos; ' : ''}if (${cond}${nullable ? ' && pos > s' : ''}) return true;${undo ? ' back(s);' : ''} }`, 'return false;'),
    commitFail: '{ return false; }',
    commitSw: commitSwTs('_ft'),
  };
}

// The entry rule in builder form (emit-portable entryShell), recording what incremental reuse
// needs: shape A one EntryMeta per top-level entry (kidStart: its slot under the root), shape B one
// Seg + EntryMeta per segment (kidStart / kidCount: in handles). Engine-side metadata only (R2):
// consumer handles are never read or mutated; _entryHs is a copy of the root's children.
const ENTRY_META_TS = `type EntryMeta = { tokStart: number; tokEnd: number; ext: number; off: number; end: number; kidStart: number; kidCount: number };
let _entries: EntryMeta[] = [];
let _entryHs: any[] = [];
`;
function rdEntryWithReuseW(r: RdRule, plan: ReusePlan, ids: LexIdPlan): string {
  return entryShell(plan, ids, {
    topCall: (n) => `  return parse${n}W();`,
    topTry: (n) => `  { const sp = pos; if (parse${n}W()) return true; back(sp); }`,
    topFail: '  return false;',
    entryA: (topOne) => `${ENTRY_META_TS}function parseTopOneW(): boolean {
${topOne}
}
function parse${r.name}W(): boolean {
  const save = pos, b = _n;
  const localE: EntryMeta[] = [];
  for (;;) {
    const sp = pos, c = _n;
    lookReset();
    if (!parseTopOneW()) { back(sp); _n = c; break; }
    const s = c * _SW;
    localE.push({ tokStart: _sp[s + 2]!, tokEnd: pos, ext: Math.max(pos, lookEnd()), off: _sp[s]!, end: _sp[s + 1]!, kidStart: c - b, kidCount: 1 });
  }
  _entries = localE;
  _entryHs = _kids(b);
  finR(${J(r.name)}, b, save);
  return true;
}`,
    // A segment's head: the head rule's node, when it matched and the builder kept a handle of it.
    headSeg: (rule) => `function parseHeadSegW(kidStart: number): { seg: Seg; meta: EntryMeta } | null {
  lookReset();
  const c = _n;
  optW(parse${rule}W);
  if (_count(c) === 0) return null;
  const s = c * _SW;
  const tokStart = _sp[s + 2]!, tokEnd = pos;
  const ext = Math.max(tokEnd, lookEnd());
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: _sp[s]!, end: _sp[(_n - 1) * _SW + 1]!, kidStart, kidCount: 1 };
  return { seg: { kidStart, kidCount: 1, tokStart, tokEnd, ext }, meta };
}
`,
    headUse: `  {
    const pair = parseHeadSegW(0);
    if (pair) { segs.push(pair.seg); localE.push(pair.meta); }
  }
  let k = _count(b);
`,
    // A loop segment: its leading token, then the loop rule when it follows; its span runs from
    // that token to the last child it left (the token itself when the builder dropped every child).
    loopSeg: (kid, rule) => `function parseLoopSegW(kidStart: number): { seg: Seg; meta: EntryMeta } | null {
  const sp = pos, c = _n;
  lookReset();
  const t = peek();
  if (t === null || !matchTokW(${kid})) { back(sp); _n = c; return null; }
  optW(parse${rule}W);
  const tokStart = sp, tokEnd = pos;
  const end = _n > c ? _sp[(_n - 1) * _SW + 1]! : t.end;
  const ext = Math.max(tokEnd, lookEnd());
  const kidCount = _count(c);
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: t.off, end, kidStart, kidCount };
  return { seg: { kidStart, kidCount, tokStart, tokEnd, ext }, meta };
}`,
    entryB: (headSeg, headUse, loopSeg) => `type Seg = { kidStart: number; kidCount: number; tokStart: number; tokEnd: number; ext: number };
${ENTRY_META_TS}let _segs: Seg[] = [];
${headSeg}${loopSeg}
function parse${r.name}W(): boolean {
  const save = pos, b = _n;
  const segs: Seg[] = [];
  const localE: EntryMeta[] = [];
${headUse || '  let k = 0;\n'}  for (;;) {
    const pair = parseLoopSegW(k);
    if (pair === null) break;
    segs.push(pair.seg);
    localE.push(pair.meta);
    k += pair.meta.kidCount;
  }
  _segs = segs;
  _entries = localE;
  _entryHs = _kids(b);
  finR(${J(r.name)}, b, save);
  return true;
}`,
  });
}

/** A Pratt rule's operator tables (emit-portable prattOpTables), keyed by the operator's lid. TS:
 *  an object literal with integer keys, which V8 keeps as indexed elements (no hashing); the
 *  typed-AST printers read the same tables. */
function tsPrattOpTables(r: PrattRule, ids: LexIdPlan): string {
  const ops = prattOpTables(r, ids);
  const rec = <T extends { lid: number }>(xs: T[], v: (x: T) => string | number) => `{ ${xs.map((x) => `${x.lid}: ${v(x)}`).join(', ')} }`;
  const set = <T extends { lid: number; tgt: boolean }>(xs: T[]) => `new Set<number>([${xs.filter((x) => x.tgt).map((x) => x.lid).join(', ')}])`;
  return `const ${r.name}_BIN: Record<number, { lbp: number; rbp: number; tgt: boolean; noUnary: boolean }> = ${rec(ops.bin, (b) => `{ lbp: ${b.lbp}, rbp: ${b.rbp}, tgt: ${b.tgt}, noUnary: ${b.noUnary} }`)};
const ${r.name}_PRE: Record<number, number> = ${rec(ops.pre, (p) => p.rbp)};
const ${r.name}_PRE_FORM: Record<number, number> = ${rec(ops.pre, (p) => p.form)};
const ${r.name}_PRE_TGT = ${set(ops.pre)};
const ${r.name}_POST: Record<number, number> = ${rec(ops.post, (p) => p.lbp)};
const ${r.name}_POST_TGT = ${set(ops.post)};`;
}

/** A Pratt rule in building form, over the child stack (emit-portable prattShell): its operator
 *  tables ${name}_BIN / _PRE / _POST, then `X_bpW` / `X_nudW`, which return whether they matched;
 *  matched, the node is the one slot left at the height `b` they found, else the stack is back at
 *  `b`. In the led loop the left operand is slot `b`: a led appends its other children after it,
 *  and `finP` finishes them all into slot `b`, the new left operand. */
// A NUD that matched nothing: the state its frame leaves when no arm won (prattRuleW's nudClose).
const NUD_FAIL_TS = '{ return nudNone(); }';
function prattRuleW(r: PrattRule, ir: ParserIR, ids: LexIdPlan): string {
  const cn = J(r.name);
  const d = r.nudDispatch;
  // A NUD arm that won: its node at slot c finished (`fin`), _keep moves it over the best it beat.
  const won = (i: number, fin: string, form: string, tail: boolean, capped: boolean) =>
    `${fin}(${cn}, c${fin === 'finR' ? ', save' : ''}); _keep(b, c); bestPos = pos;${markTs(d, i)} bf = ${form}; bt = ${tail}; bc = ${capped};`;
  const L: PrattLowering = {
    steps: tsSteps(ids, 'w'),
    ifAll: ifTs,
    kidIs: (k) => `t.kid === ${k}`,
    lidIs: (l) => `t.lid === ${l}`,
    capBelow: (bp) => `minBp < ${bp}`,
    nudGuard: (g, keyed) => guardCond(g, 't', keyed),
    beats: (i, end) => beatsTs(d, end, i),
    leafEnd: 'save + 1',
    nudLeaf: (i) => `{ const c = _n; leafSlotW(tok_kind(t), t); pos++; ${won(i, 'finP', '0', false, false)} back(save); }`,
    nudTpl: (i, hole) => `  if (t.kid === ${kidOf(ids, '$templateHead')}) { const c = _n; if (matchTemplateW(parse${hole}W) && ${beatsTs(d, 'pos', i)}) { ${won(i, 'finP', '0', false, false)} } else _n = c; back(save); }`,
    nudSeq: (i, cond, tail, capped) => candTs(d, i, 'w', cond, won(i, 'finR', '0', tail, capped)),
    // An operand that parses but is not the target the operator requires fails the whole Pratt
    // call, whatever another arm matched.
    nudPrefix: (i) => `  { const pbp = ${r.name}_PRE[t.lid];
    if (pbp !== undefined) {
      const c = _n;
      leafSlotW('$operator', t);
      pos++;
      if (${r.name}_bpW(pbp)) {
        if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { back(save); _n = b; _capped = false; return false; }
        if (${beatsTs(d, 'pos', i)}) { ${won(i, 'finP', `${r.name}_PRE_FORM[t.lid]!`, true, false)} } else _n = c;
      } else _n = c;
      back(save);
    } }`,
    dispatch: dispatchTsL('t'),
    // A committed arm (emit-portable.ts Commit) leaves what the frame's close would: its node (the
    // one slot at b), form, tail and capped flag; failing, no node and the frame's empty state.
    commitLeaf: (_i, conds) => commitTs(conds, `{ const b = _n; leafSlotW(tok_kind(t), t); pos++; finP(${cn}, b); _form = 0; _tail = false; return true; }`, NUD_FAIL_TS, true),
    commitSeq: (_i, conds, cond, tail, capped, undo, nullable) => commitTs(conds, `{ const s = pos, b = _n; if (${cond}${nullable ? ' && pos > s' : ''}) { finR(${cn}, b, s); _capped = ${capped}; _form = 0; _tail = ${tail}; return true; }${undo ? ' back(s); _n = b;' : ''} }`, NUD_FAIL_TS),
    commitPrefix: (_i, conds) => commitTs(conds, `{ const pbp = ${r.name}_PRE[t.lid];
    if (pbp !== undefined) {
      const save = pos, b = _n;
      leafSlotW('$operator', t);
      pos++;
      if (${r.name}_bpW(pbp)) {
        if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { back(save); _n = b; _capped = false; return false; }
        finP(${cn}, b); _form = ${r.name}_PRE_FORM[t.lid]!; _tail = true; _capped = false; return true;
      }
      back(save); _n = b;
    } }`, NUD_FAIL_TS),
    commitFail: NUD_FAIL_TS,
    nudEnd: '}',
    commitSw: commitSwTs('t'),
    led: {
      tailOpen: '!tailClosed',
      lbpAbove: (lbp) => `${lbp} > minBp`,
      sameLine: '!t.nl',
      notLeftLeaf: (words) => `!${liftConst(ids, J(words))}.includes(headLeafTextW(b))`,
      notSuppressed: (set) => `_suppressCur !== ${set}`,
      ifAll: (parts) => (parts.length ? `if (${parts.join(' && ')}) ` : ''),
    },
    ledArm: (_i, cond, form, closes, exit) => `{
      const ledSave = pos;
      if (${cond}) { finP(${cn}, b); form = ${form};${closes ? ' tailClosed = true;' : ''} continue ledLoop; }
      back(ledSave); _n = b + 1;${exit ? ' break ledLoop;' : ''}
    }`,
    ledSwitch: (cases) => `    switch (t.lid) {
${cases.map((c) => `      case ${c.key}:\n${c.arms.map((a) => `      ${a}`).join('\n')}\n        break;`).join('\n')}
    }`,
    postfixToks: (kids) => `    switch (t.kid) {
${kids.map((k) => `      case ${k}:
        if (!tailClosed) { leafSlotW(tok_kind(t), t); pos++; finP(${cn}, b); form = 0; continue ledLoop; }
        break;`).join('\n')}
    }`,
    postfixTpl: (hole) => `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) { if (matchTemplateW(parse${hole}W)) { finP(${cn}, b); form = 0; continue ledLoop; } }`,
    postfixOp: `    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) { _n = b; return false; }
      leafSlotW('$operator', t); pos++; finP(${cn}, b); tailClosed = true; form = 1; continue;
    }`,
    binary: `    const opLid = _opLid(t);
    const info = ${r.name}_BIN[opLid];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) { _n = b; return false; }
    const ledSave = pos;
    opLeafW(t, opLid);
    pos += _opN;
    if (!${r.name}_bpW(info.rbp)) { back(ledSave); _n = b + 1; break; }
    finP(${cn}, b);
    form = 1; tailClosed = true;
  }`,
    entry: `${tsPrattOpTables(r, ids)}
function parse${r.name}W(): boolean {
  const prev = _suppressCur; _suppressCur = _suppressNext; _suppressNext = 0;
  const r = ${r.name}_bpW(0);
  _suppressCur = prev;
  return r;
}`,
    bpOpen: (label) => `function ${r.name}_bpW(minBp: number): boolean {
  const b = _n;
  if (!${r.name}_nudW(minBp)) return false;
  let form = _form;
  if (_capped) return true;   // an assignment-level arrow admits no led
  let tailClosed = _tail;
  ${label ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;`,
    bpClose: `  _form = form;
  return true;
}`,
    nudEnter: `function ${r.name}_nudW(minBp: number): boolean {
  _capped = false;
  const t = peek();
  if (t === null) return false;`,
    nudOpen: `  const save = pos, b = _n;
  let bestPos = save${biTs(d)}, bf = 0, bt = false, bc = false;`,
    nudClose: `  // A sub-parse may leave _capped set (e.g. grouping a capped arrow): only a capped arm that
  // won makes THIS node capped.
  _capped = bc;
  _form = bf;
  _tail = bt;
  pos = bestPos;
  return _n !== b;
}`,
  };
  return prattShell(r, ir, ids, L);
}

/** The parse engine: the builder protocol, the child stack, the step helpers in building and
 *  recognize form, and every rule in the forms its call sites need (ParserIR.forms). parse() runs
 *  it with cstBuilder, parseWith() with the caller's builder. */
function engineRuntime(ir: ParserIR, ids: LexIdPlan): string {
  const reuse = ir.reuse;
  const ruleFns = [...ir.rules.filter((r) => ir.forms.buildRules.includes(r.name)).map((r) => {
    if (r.kind === 'pratt') return prattRuleW(r, ir, ids);
    if (reuse && r.name === ir.entry) return rdEntryWithReuseW(r, reuse, ids);
    return rdRuleW(r, ids);
  }), ...ir.rules.filter((r) => ir.forms.recognizeRules.includes(r.name)).map((r) => ruleR(r, ids))].join('\n\n');
  const matchTemplateW = ir.tpl ? `// interp: the rule that parses each \`\${…}\` hole — the one the matching reference declares.
// Matched, the template node is one slot at the height it found; else the stack is back there.
function matchTemplateW(interp: () => boolean): boolean {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return false;
  const save = pos, c = _n;
  leafSlotW('$templateHead', t); pos++;
  for (;;) {
    if (!interp()) { back(save); _n = c; return false; }
    const next = peek();
    if (next === null) { back(save); _n = c; return false; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) { leafSlotW('$templateMiddle', next); pos++; continue; }
    if (next.kid === ${kidOf(ids, '$templateTail')}) { leafSlotW('$templateTail', next); pos++; break; }
    back(save); _n = c; return false;
  }
  finR('$template', c, save);
  return true;
}
` : '';
  return `// ─── Builder API: the parse engine, driven by a Builder (parse(): cstBuilder) ─
// Builder must be pure / bottom-up. Backtracking drops what the builder returned for an attempt
// that lost — there is no rollback callback; discarded handles become garbage.
// Optional shift: method presence (builder.shift == null → Doc.edit fresh parseWith).
// treeEq on validate: only when builder === cstBuilder (rust SUPPORTS_TREE_EQ analogue).
export type Builder<H> = {
  leaf(tokenType: string, kid: number, lid: number, off: number, end: number): H | null;
  node(rule: string, children: H[], off: number, end: number): H | H[] | null;
  /** Optional incremental shift. Missing → Doc.edit degenerates to fresh parseWith. */
  shift?(h: H, byteDelta: number, tokDelta: number): H;
};
let _builder: Builder<any> = null!;
let _bSave = 0;
// The child stack: the children of every node under construction, one SLOT per child, slots 0.._n-1.
// A slot holds what the builder returned for the child in _hs, and its span in _sp, _SW int32s per
// slot: off, end, tokStart, headOff, headEnd (the first leaf's span), kind — 1: one handle, 2: an
// array of handles to splice in, 0: none (the builder dropped it; its span still counts). A mark
// is the height _n (with the position); undoing an attempt sets _n back and allocates nothing.
// Finishing a node replaces its children's slots with the node's own slot; its children array is
// allocated there, once, at its exact size (_kids), so an attempt that does not finish never has
// one. Both buffers are kept across parses (parseWith clears what _hs still references).
const _SW = 6;
let _hs: any[] = [];
let _sp = new Int32Array(_SW * 256);
let _n = 0;
function _slot(h: any, kind: number, off: number, end: number, tokStart: number, headOff: number, headEnd: number): void {
  const s = _n * _SW;
  if (s === _sp.length) { const a = new Int32Array(s * 2); a.set(_sp); _sp = a; }
  _hs[_n++] = h;
  _sp[s] = off; _sp[s + 1] = end; _sp[s + 2] = tokStart; _sp[s + 3] = headOff; _sp[s + 4] = headEnd; _sp[s + 5] = kind;
}
// The handles of slots b.._n-1 (spliced arrays flattened, dropped children left out), as a new array of exactly their count.
function _kids(b: number): any[] {
  for (let i = b; i < _n; i++) if (_sp[i * _SW + 5] !== 1) return _spread(b);
  return _hs.slice(b, _n);
}
function _spread(b: number): any[] {
  const out = new Array(_count(b));
  let k = 0;
  for (let i = b; i < _n; i++) {
    const kind = _sp[i * _SW + 5];
    if (kind === 1) out[k++] = _hs[i];
    else if (kind === 2) for (const h of _hs[i] as any[]) out[k++] = h;
  }
  return out;
}
// How many handles slots c.._n-1 hold.
function _count(c: number): number {
  let k = 0;
  for (let i = c; i < _n; i++) { const kind = _sp[i * _SW + 5]; k += kind === 1 ? 1 : kind === 2 ? (_hs[i] as any[]).length : 0; }
  return k;
}
// The node over slots b.._n-1 replaces them as one slot at b: the builder's node, with the span
// from the first child to the last and the first child's head.
function _put(rule: string, b: number, off: number, end: number, tokStart: number, headOff: number, headEnd: number): void {
  _bSave = tokStart;
  const r = _builder.node(rule, _kids(b), off, end);
  _n = b;
  _slot(r, r === null ? 0 : Array.isArray(r) ? 2 : 1, off, end, tokStart, headOff, headEnd);
}
// An rd rule's node (and a template's), tried from token save: with no child, its span is empty at that token.
function finR(rule: string, b: number, save: number): void {
  if (_n > b) { const s = b * _SW; _put(rule, b, _sp[s]!, _sp[(_n - 1) * _SW + 1]!, save, _sp[s + 3]!, _sp[s + 4]!); return; }
  const off = save < toks.length ? toks[save]!.off : 0;
  _put(rule, b, off, off, save, off, off);
}
// A Pratt rule's node: it starts at its first child's token (with none, at offset 0 and the current token).
function finP(rule: string, b: number): void {
  if (_n > b) { const s = b * _SW; _put(rule, b, _sp[s]!, _sp[(_n - 1) * _SW + 1]!, _sp[s + 2]!, _sp[s + 3]!, _sp[s + 4]!); return; }
  _put(rule, b, 0, 0, pos, 0, 0);
}
// A longest-match candidate's node, just finished at slot c, becomes the list's best at slot b,
// over the best it beat (if any: slot b, with c = b + 1).
function _keep(b: number, c: number): void {
  if (c === b) return;
  _hs[b] = _hs[c];
  _sp.copyWithin(b * _SW, c * _SW, c * _SW + _SW);
  _n = b + 1;
}
// A leaf the builder keeps, as a slot (a dropped one leaves none: a step's literal or token).
function leafW(ttype: string, t: Tok): void {
  const h = _builder.leaf(ttype, t.kid, t.lid, t.off, t.end);
  if (h !== null) _slot(h, 1, t.off, t.end, pos, t.off, t.end);
}
// A leaf whose span counts whether or not the builder keeps it (a Pratt operand or operator, a template part).
function leafSlotW(ttype: string, t: Tok): void {
  const h = _builder.leaf(ttype, t.kid, t.lid, t.off, t.end);
  _slot(h, h === null ? 0 : 1, t.off, t.end, pos, t.off, t.end);
}
// A binary operator leaf: the composite _opLid just read (lid, _opN tokens, ending at _opEnd).
function opLeafW(t: Tok, lid: number): void {
  const h = _builder.leaf('$operator', t.kid, lid, t.off, _opEnd);
  _slot(h, h === null ? 0 : 1, t.off, _opEnd, pos, t.off, _opEnd);
}
function headLeafTextW(b: number): string { return _src.slice(_sp[b * _SW + 3], _sp[b * _SW + 4]); }
// A literal is a \`$keyword\` leaf when it is a word (the lids from _LID_KW on), else \`$punct\`.
function matchLitW(lid: number): boolean {
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  leafW(lid >= _LID_KW ? '$keyword' : '$punct', t); pos++;
  return true;
}
function matchTokW(kid: number): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  leafW(KIND_STR[kid]!, t); pos++;
  return true;
}
function starW(once: () => boolean): boolean {
  for (;;) { const sp = pos, bk = _n; if (!once()) { back(sp); _n = bk; break; } }
  return true;
}
function starInW(k: number, once: () => boolean): boolean {
  while (ahead(k, true)) { const sp = pos, bk = _n; if (!once()) { back(sp); _n = bk; break; } }
  return true;
}
// A clean body (Step.clean) leaves no trace when it fails: no mark, nothing to undo.
function starC(once: () => boolean): boolean { while (once()); return true; }
function starInC(k: number, once: () => boolean): boolean { while (ahead(k, true) && once()); return true; }
function sepByCW(elem: () => boolean, delimLid: number): boolean { if (elem()) while (matchLitW(delimLid) && elem()); return true; }
function optW(body: () => boolean): boolean {
  const sp = pos, bk = _n; if (!body()) { back(sp); _n = bk; } return true;
}
function sepByW(elem: () => boolean, delimLid: number): boolean {
  // Match interpreter matchSep: restore on elem failure (zero elems OK; trailing delim keeps delim).
  const sp0 = pos, bk0 = _n;
  if (!elem()) { back(sp0); _n = bk0; return true; }
  for (;;) {
    // A failed delimiter match changes nothing: no mark before it.
    if (!matchLitW(delimLid)) break;
    const sp2 = pos, bk2 = _n;
    if (!elem()) { back(sp2); _n = bk2; break; }
  }
  return true;
}
function altLitW(lids: number[]): boolean {
  for (const lid of lids) if (matchLitW(lid)) return true;
  return false;
}
// A recognized Pratt rule (ParserIR.forms) runs its building form: its node, if any, is dropped
// from the stack back to height b.
function _drop(b: number, ok: boolean): boolean { _n = b; return ok; }
// The recognize forms (ParserIR.forms): the same tokens examined, nothing built.
function matchLitR(lid: number): boolean {
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  pos++; return true;
}
function matchTokR(kid: number): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  pos++; return true;
}
function starR(once: () => boolean): boolean {
  for (;;) { const sp = pos; if (!once()) { back(sp); break; } }
  return true;
}
function starInR(k: number, once: () => boolean): boolean {
  while (ahead(k, true)) { const sp = pos; if (!once()) { back(sp); break; } }
  return true;
}
function optR(body: () => boolean): boolean {
  const sp = pos; if (!body()) back(sp); return true;
}
function sepByCR(elem: () => boolean, delimLid: number): boolean { if (elem()) while (matchLitR(delimLid) && elem()); return true; }
function sepByR(elem: () => boolean, delimLid: number): boolean {
  const sp0 = pos;
  if (!elem()) { back(sp0); return true; }
  for (;;) {
    // A failed delimiter match changes nothing: no mark before it.
    if (!matchLitR(delimLid)) break;
    const sp2 = pos;
    if (!elem()) { back(sp2); break; }
  }
  return true;
}
function altLitR(lids: number[]): boolean {
  for (const lid of lids) if (matchLitR(lid)) return true;
  return false;
}
${matchTemplateW}${lookFns(ir, ids)}${sharedFns(ir, ids, 'w')}${sharedFns(ir, ids, 'r')}${ruleFns}

/** The default builder: the CST (plain Node / Leaf objects); parse() is parseWith(src, cstBuilder). */
export const cstBuilder: Builder<Cst> = {
  leaf(tokenType, _kid, _lid, off, end) {
    if (tokenType === '$punct') return null;
    return { tokenType, offset: off, end };
  },
  node(rule, children, off, end) {
    return { rule, children, offset: off, end };
  },${reuse ? `
  shift(h, byteDelta, tokDelta) {
    shiftSubtree(h, byteDelta, tokDelta);
    return h;
  },` : ''}
};
`;
}

/** The library's entry points over the engine: parse, parseWith, and the incremental Doc. */
// createDoc().edit: a lexer error in the relex is the text's own (the relexed stream equals a fresh
// lex: relex-family.ts), so the text is rejected and the Doc keeps no token stream (the next edit
// relexes it all).
function docRuntime(ir: ParserIR): string {
  const reuse = ir.reuse;
  const topReuse = reuse !== null;
  const shapeA = reuse?.kind === 'A';
  const shapeB = reuse?.kind === 'B';
  const hasHeadB = reuse?.kind === 'B' && reuse.hasHead;
  const entryCst = ir.entry;
  return `// The one handle slot i holds, when it holds exactly one (a root; a reused top-level entry).
function _soleOk(i: number): boolean { const k = _sp[i * _SW + 5]; return k === 1 || k === 2 && (_hs[i] as any[]).length === 1; }
function _sole(i: number): any { return _sp[i * _SW + 5] === 1 ? _hs[i] : (_hs[i] as any[])[0]; }
// The entry rule over toks from token 0 with builder: its root handle, or null (no match, input
// left over, or a root the builder dropped or spliced into several handles).
function runW<H>(builder: Builder<H>): H | null {
  pos = 0;
  lookReset();
  _builder = builder;
  _n = 0;
  const ok = parse${ir.entry}W() && pos === toks.length;
  const sole = ok && _soleOk(0);
  const root = sole ? _sole(0) as H : null;
  _hs.fill(null);   // the stack keeps no handle of this parse alive
  // Accepting or rejecting is the parser's verdict, never the builder's: an accepted parse whose
  // builder kept no single node for the root (the entry rule) breaks the builder contract.
  if (ok && !sole) throw new Error('the builder kept no node for the root rule of an accepted parse (a Builder must return one for the entry rule)');
  return root;
}

/**
 * parseWith: the grammar's parser driven by \`builder\`.
 * Handles are opaque — the parser never reads offset/end/tok* from H.
 * Builder must be pure; backtracking drops handles without notifying the builder.
 */
export function parseWith<H>(src: string, builder: Builder<H>): H | null {
  _src = src;
  toks = lex(src);
  return runW(builder);
}

/** Parse with builder over AlignMeta-backed toks (Doc.edit path; avoids relex). */
function parseWithMeta<H>(text: string, meta: AlignMeta[], builder: Builder<H>): { root: H | null; entries: any[]; entryHs: any[]; segs: any[] } {
  _src = text;
  toks = toksFromMeta(text, meta);
  const root = runW(builder);
  if (root === null) return { root: null, entries: [], entryHs: [], segs: [] };
  return {
    root,
    entries: ${topReuse ? '_entries.slice()' : '[] as any[]'},
    entryHs: ${topReuse ? '_entryHs.slice()' : '[] as any[]'},
    segs: ${shapeB ? '_segs.slice()' : '[] as any[]'},
  };
}
${shapeA ? `
function tryReuseTopW<H>(builder: Builder<H>, shift: (h: H, bd: number, td: number) => H, oldHs: H[], oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null {
  const [prefixLen, suffixStart] = reuseBounds(oldEntries, prefix, oldN, suffix);
  const prefixKids = oldHs.slice(0, prefixLen);
  const suffixCand = oldHs.slice(suffixStart);
  const prefixMeta = oldEntries.slice(0, prefixLen);
  const suffixMeta = oldEntries.slice(suffixStart);
  const tokDelta = newN - oldN;
  _src = newText;
  toks = toksFromMeta(newText, newMeta);
  pos = prefixLen > 0 ? prefixMeta[prefixLen - 1]!.tokEnd : 0;
  _builder = builder;
  const mid: H[] = [];
  const midMeta: EntryMeta[] = [];
  const finish = (adoptFrom: number): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const adopted = suffixCand.slice(adoptFrom).map((h) => shift(h, byteDelta, tokDelta));
    const children: H[] = [...prefixKids, ...mid, ...adopted];
    const newEntries = reuseEntries(prefixMeta, midMeta, suffixMeta, adoptFrom, byteDelta, tokDelta);
    const [offset, end, tokStart, tokEnd] = reuseSpan(newEntries);
    _bSave = tokStart;
    const savePos = pos;
    pos = tokEnd;
    const r = builder.node(${J(entryCst)}, children, offset, end);
    pos = savePos;
    if (r === null || Array.isArray(r)) return null;
    return { root: r as H, entries: newEntries, entryHs: children, reused: prefixKids.length + adopted.length };
  };
  const tryHit = (): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const at = reuseAdoptAt(suffixMeta, oldN, suffix, newN - pos);
    return at >= 0 ? finish(at) : null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (reuseGaveUp(suffixMeta, oldN, newN - pos)) return null;
  }
  for (;;) {
    if (pos >= toks.length) {
      return tryHit();
    }
    lookReset();
    const sp = pos;
    _n = 0;
    const ok = parseTopOneW() && _soleOk(0);
    const h = ok ? _sole(0) as H : null;
    _hs.fill(null);
    if (!ok) { back(sp); return null; }
    const ext = Math.max(pos, lookEnd());
    midMeta.push({ tokStart: _sp[2]!, tokEnd: pos, ext, off: _sp[0]!, end: _sp[1]!, kidStart: 0, kidCount: 1 });
    mid.push(h!);
    const hit = tryHit();
    if (hit) return hit;
    if (reuseGaveUp(suffixMeta, oldN, newN - pos)) return null;
  }
}
` : ''}${shapeB ? `
function tryReuseSegW<H>(builder: Builder<H>, shift: (h: H, bd: number, td: number) => H, oldRootHs: H[], oldSegs: Seg[], oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null {
  if (oldSegs.length === 0) return null;
  const [prefixLen, suffixStart] = reuseBounds(oldEntries, prefix, oldN, suffix);
  const prefixSegs = oldSegs.slice(0, prefixLen);
  const suffixCand = oldSegs.slice(suffixStart);
  const prefixMeta = oldEntries.slice(0, prefixLen);
  const suffixMeta = oldEntries.slice(suffixStart);
  const prefixKids: H[] = [];
  for (const s of prefixSegs) {
    for (let i = 0; i < s.kidCount; i++) prefixKids.push(oldRootHs[s.kidStart + i]!);
  }
  const tokDelta = newN - oldN;
  _src = newText;
  toks = toksFromMeta(newText, newMeta);
  pos = prefixLen > 0 ? prefixMeta[prefixLen - 1]!.tokEnd : 0;
  _builder = builder;
  const midKids: H[] = [];
  const midSegs: Seg[] = [];
  const midMeta: EntryMeta[] = [];
  const finish = (adoptFrom: number): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const adoptedSegs = suffixCand.slice(adoptFrom);
    const adoptedKids: H[] = [];
    for (const s of adoptedSegs) {
      for (let i = 0; i < s.kidCount; i++) {
        adoptedKids.push(shift(oldRootHs[s.kidStart + i]!, byteDelta, tokDelta));
      }
    }
    const children: H[] = [...prefixKids, ...midKids, ...adoptedKids];
    const [newSegs, newEntries] = reuseSegEntries(prefixSegs, prefixMeta, midSegs, midMeta, suffixCand, suffixMeta, adoptFrom, byteDelta, tokDelta);
    const [offset, end, tokStart, tokEnd] = reuseSpan(newEntries);
    _bSave = tokStart;
    const savePos = pos;
    pos = tokEnd;
    const r = builder.node(${J(entryCst)}, children, offset, end);
    pos = savePos;
    if (r === null || Array.isArray(r)) return null;
    return { root: r as H, segs: newSegs, entries: newEntries, entryHs: children, reused: prefixSegs.length + adoptedSegs.length };
  };
  const tryHit = (): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const at = reuseAdoptAt(suffixMeta, oldN, suffix, newN - pos);
    return at >= 0 ? finish(at) : null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (reuseGaveUp(suffixMeta, oldN, newN - pos)) return null;
  }
  ${hasHeadB ? `if (prefixLen === 0) {
    _n = 0;
    const pair = parseHeadSegW(0);
    for (const h of _kids(0)) midKids.push(h);
    _hs.fill(null);
    if (pair) {
      midSegs.push({ kidStart: 0, kidCount: pair.seg.kidCount, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
      midMeta.push({ ...pair.meta, kidStart: 0 });
      const hit = tryHit();
      if (hit) return hit;
      if (reuseGaveUp(suffixMeta, oldN, newN - pos)) return null;
    }
  }
  ` : ''}for (;;) {
    if (pos >= toks.length) {
      return tryHit();
    }
    const before = midKids.length;
    _n = 0;
    const pair = parseLoopSegW(before);
    for (const h of _kids(0)) midKids.push(h);
    _hs.fill(null);
    if (pair === null) {
      return tryHit();
    }
    midSegs.push({ kidStart: before, kidCount: midKids.length - before, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
    midMeta.push({ tokStart: pair.meta.tokStart, tokEnd: pair.meta.tokEnd, ext: pair.meta.ext, off: pair.meta.off, end: pair.meta.end, kidStart: 0, kidCount: midKids.length - before });
    const hit = tryHit();
    if (hit) return hit;
    if (reuseGaveUp(suffixMeta, oldN, newN - pos)) return null;
  }
}
` : ''}
/**
 * createDoc: an incremental document parsed with \`builder\` (default cstBuilder). An edit relexes
 * a window and, when the builder can shift, reuses the top-level entries the edit cannot affect.
 * validate: align() also reports whether the token stream (and, with cstBuilder, the tree) equals
 * a fresh parse's, and with cstBuilder the recorded entries are checked against the old tree.
 */
export function createDoc<H = Node>(src: string, opts?: { validate?: boolean; builder?: Builder<H> }): { text(): string; root(): H | null; align(): Align | null; edit(edits: Edit[]): H | null } {
  const builder = opts?.builder ?? (cstBuilder as unknown as Builder<H>);
  const isCst = builder === (cstBuilder as unknown as Builder<H>);
  const validate = opts?.validate === true;
  const supportsShift = typeof builder.shift === 'function';
  const shift = supportsShift ? builder.shift!.bind(builder) : null;
  let text = src;
  let [prevToks, lexErr] = scanMeta(src);
  if (lexErr !== null) throw lexError(src, lexErr);
  let align: Align | null = null;${shapeB ? `
  let segs: Seg[] = [];` : ''}${topReuse ? `
  let entries: EntryMeta[] = [];
  let entryHs: H[] = [];` : ''}
  let root: H | null = null;
  {
    const got = parseWithMeta(src, prevToks, builder);
    root = got.root;${topReuse ? `
    entries = got.entries;
    entryHs = got.entryHs as H[];` : ''}${shapeB ? `
    segs = got.segs;` : ''}
  }
  return {
    text(): string { return text; },
    root(): H | null { return root; },
    align(): Align | null { return align; },
    edit(edits: Edit[]): H | null {
      const oldText = text, oldToks = prevToks;
      let relexed = 0;
      // A lexer error (the generator's docRuntime): the text's own.
      [text, prevToks, relexed, lexErr] = relexEdits(oldText, oldToks, edits);
      if (lexErr !== null) {
        text = applyEdits(oldText, edits);
        prevToks = [];
        root = null;${topReuse ? `
        entries = [];
        entryHs = [];` : ''}${shapeB ? `
        segs = [];` : ''}
        const lexReject = { oldN: oldToks.length, newN: 0, prefix: 0, suffix: 0, relexed: 0, reused: 0 };
        align = validate ? { ...lexReject, streamEq: true, treeEq: isCst ? true : null } : lexReject;
        return null;
      }
      const [oldN, newN, prefix, suffix] = computeAlignCore(oldText, oldToks, text, prevToks);
      const core = { oldN, newN, prefix, suffix, relexed };
      const byteDelta = text.length - oldText.length;
      let reused = 0;
      let next: H | null = null;
      const forceFresh = !supportsShift || root === null;${shapeA ? `
      if (!forceFresh) {
        if (validate && isCst) assertEntriesVsNodes(entries, root as unknown as Node);
        const got = tryReuseTopW(builder, shift!, entryHs, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix);
        if (got) { next = got.root; entries = got.entries; entryHs = got.entryHs; reused = got.reused; }
      }` : ''}${shapeB ? `
      if (!forceFresh && segs.length > 0) {
        if (validate && isCst) assertEntriesVsSegs(entries, segs, root as unknown as Node);
        const got = tryReuseSegW(builder, shift!, entryHs, segs, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix);
        if (got) { next = got.root; segs = got.segs; entries = got.entries; entryHs = got.entryHs; reused = got.reused; }
      }` : ''}
      if (next === null) {
        const got = parseWithMeta(text, prevToks, builder);
        next = got.root;${topReuse ? `
        entries = got.entries;
        entryHs = got.entryHs as H[];` : ''}${shapeB ? `
        segs = got.segs;` : ''}
        reused = 0;
      }
      root = next;
      if (validate) {
        let streamEq = false;
        try { streamEq = checkStreamEq(text, prevToks); } catch { streamEq = false; }
        // treeEq: the tree against a fresh parse's, with cstBuilder only; any other builder's
        // handles are opaque, so it reports null (rust SUPPORTS_TREE_EQ=false).
        align = { ...core, reused, streamEq, treeEq: isCst ? checkTreeEq(text, root as unknown as Node | null) : null };
      } else {
        align = { ...core, reused };
      }
      return root;
    },
  };
}
`;
}

// The Doc's token metadata, the relex family and the edit-time checks.
function docEditBlock(ir: ParserIR, shared: SharedAlgorithms): string {
  const topReuse = ir.reuse;
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const relexFamily = `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.relexFamily(ir)}\n`;
  const reuseFamily = `\n// ---- reuse family: generated from src/reuse-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.reuseFamily(ir)}\n`;
  // validate with cstBuilder: the tree against a fresh parse's, and (reusing entries) the recorded
  // entries against the old tree.
  const reuseFns = `
function cstJSON(n: Cst): string {
  return JSON.stringify(n);
}
function checkTreeEq(text: string, root: Node | null): boolean {
  try {
    const fresh = parse(text);
    if (root === null || fresh === null) return root === fresh;
    return cstJSON(root) === cstJSON(fresh as Cst);
  } catch { return root === null; }
}
${topReuse ? `function shiftSubtree(n: Cst, byteDelta: number, tokDelta: number): void {
  n.offset += byteDelta;
  n.end += byteDelta;
  if ('children' in n) for (const c of n.children) shiftSubtree(c, byteDelta, tokDelta);
}
${shapeA ? `function assertEntriesVsNodes(entries: EntryMeta[], oldRoot: Node): void {
  const oldKids = oldRoot.children as Node[];
  if (entries.length !== oldKids.length) throw new Error('entry count vs root kids: ' + entries.length + ' vs ' + oldKids.length);
  for (let i = 0; i < entries.length; i++) {
    const nd = oldKids[i]!;
    const e = entries[i]!;
    if (e.tokStart > e.tokEnd || e.ext < e.tokEnd || (i > 0 && entries[i - 1]!.tokEnd !== e.tokStart)) throw new Error('tok span entry ' + i);
    if (e.off !== nd.offset) throw new Error('off entry ' + i);
    if (e.end !== nd.end) throw new Error('end entry ' + i);
  }
}
` : ''}${shapeB ? `function assertEntriesVsSegs(entries: EntryMeta[], oldSegs: Seg[], oldRoot: Node): void {
  if (entries.length !== oldSegs.length) throw new Error('entry count vs segs: ' + entries.length + ' vs ' + oldSegs.length);
  const oldKids = oldRoot.children;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const s = oldSegs[i]!;
    if (e.tokStart !== s.tokStart) throw new Error('tok_start entry ' + i);
    if (e.tokEnd !== s.tokEnd) throw new Error('tok_end entry ' + i);
    if (e.ext !== s.ext) throw new Error('ext entry ' + i);
    if (e.kidStart !== s.kidStart) throw new Error('kid_start entry ' + i);
    if (e.kidCount !== s.kidCount) throw new Error('kid_count entry ' + i);
    const first = oldKids[s.kidStart]!;
    const last = oldKids[s.kidStart + s.kidCount - 1]!;
    if ('rule' in first && e.off !== first.offset) throw new Error('off entry ' + i);
    if ('rule' in last && e.end !== last.end) throw new Error('end entry ' + i);
  }
}
` : ''}` : ''}`;
  const code = `export type Edit = { start: number; end: number; text: string };
// Packed Doc-state token. kind → kid+KIND_STR; text → src.slice(off,end);
// nl/lc/lb/hd packed in flags; pd/fd/td are narrow depths (paren/flow/template).
// All constructions go through mk_align/shift_align for V8 hidden-class monomorphism.
type AlignMeta = { off: number; end: number; kid: number; pd: number; fd: number; flags: number; td: number };
function am_nl(m: AlignMeta): boolean { return (m.flags & 1) !== 0; }
function am_lc(m: AlignMeta): boolean { return (m.flags & 2) !== 0; }
function am_lb(m: AlignMeta): boolean { return (m.flags & 4) !== 0; }
function am_hd(m: AlignMeta): boolean { return (m.flags & 8) !== 0; }
function am_text(src: string, m: AlignMeta): string { return src.slice(m.off, m.end); }
function mk_align(off: number, end: number, kid: number, nl: boolean, fd: number, pd: number, lc: boolean, lb: boolean, hd: boolean, td: number): AlignMeta {
  return { off, end, kid, pd, fd, flags: (nl ? 1 : 0) | (lc ? 2 : 0) | (lb ? 4 : 0) | (hd ? 8 : 0), td };
}
function shift_align(m: AlignMeta, delta: number): AlignMeta {
  return { off: m.off + delta, end: m.end + delta, kid: m.kid, pd: m.pd, fd: m.fd, flags: m.flags, td: m.td };
}
type Align = { oldN: number; newN: number; prefix: number; suffix: number; relexed: number; reused: number; streamEq?: boolean; treeEq?: boolean | null };
${relexFamily}${reuseFamily}
function toksFromMeta(text: string, meta: AlignMeta[]): Tok[] {
  return meta.map((m) => {
    const tx = am_text(text, m);
    return mk_tok(m.off, m.end, am_nl(m), m.kid, ${regionKids(ir, buildLexIdPlan(ir)).length ? `${regionKids(ir, buildLexIdPlan(ir)).map((k) => `m.kid === ${k}`).join(' || ')} ? 0 : ` : ''}lid_of(tx));
  });
}
${reuseFns}`;
  return code;
}

// ─── Shape AST codegen (SH1/SH2-0) ────────────────────────────────────────────

type ShapeStepKind =
  | 'lit' | 'tok' | 'rule' | 'ruleBp' | 'star' | 'opt' | 'sep'
  | 'altlit' | 'alt' | 'look' | 'ahead' | 'aheadCtx' | 'seq' | 'sameLine' | 'suppress' | 'ctx';
type ShapePrattKind =
  | 'atom' | 'group' | 'prefix' | 'binary' | 'postfix' | 'postfixTok'
  | 'led' | 'nudSeq' | 'nudCapped' | 'template';
type ShapeUnsupported = { rule: string; construct: string };

const SHAPE_STEP_KINDS: readonly ShapeStepKind[] = [
  'lit', 'tok', 'rule', 'ruleBp', 'star', 'opt', 'sep',
  'altlit', 'alt', 'look', 'ahead', 'aheadCtx', 'seq', 'sameLine', 'suppress', 'ctx',
];
const SHAPE_PRATT_KINDS: readonly ShapePrattKind[] = [
  'atom', 'group', 'prefix', 'binary', 'postfix', 'postfixTok',
  'led', 'nudSeq', 'nudCapped', 'template',
];

type ShapeEmitCtx = {
  rule: string;
  look: readonly Alt[];   // ParserIR.lookaheads: the body a `look` step runs
  step: Record<ShapeStepKind, number>;
  pratt: Record<ShapePrattKind, number>;
  unsupported: ShapeUnsupported[];
  note: (construct: string) => void;
};

function newShapeEmitCtx(rule: string, look: readonly Alt[]): ShapeEmitCtx {
  const step = Object.fromEntries(SHAPE_STEP_KINDS.map((k) => [k, 0])) as Record<ShapeStepKind, number>;
  const pratt = Object.fromEntries(SHAPE_PRATT_KINDS.map((k) => [k, 0])) as Record<ShapePrattKind, number>;
  const unsupported: ShapeUnsupported[] = [];
  return {
    rule,
    look,
    step,
    pratt,
    unsupported,
    note: (construct: string) => { unsupported.push({ rule, construct }); },
  };
}

function mergeShapeEmitCtx(into: ShapeEmitCtx, from: ShapeEmitCtx): void {
  for (const k of SHAPE_STEP_KINDS) into.step[k] += from.step[k];
  for (const k of SHAPE_PRATT_KINDS) into.pratt[k] += from.pratt[k];
  into.unsupported.push(...from.unsupported);
}

function isFieldBindObj(bind: FieldBind): bind is Exclude<FieldBind, 'opText'> {
  return typeof bind !== 'string';
}

function shapeSpanFields(spans: ShapeSpec['spans']): string {
  if (spans === 'none') return '';
  if (spans === 'required') return 'off: number; end: number;';
  return 'off?: number; end?: number;';
}

function shapeTsTypeHint(hint: string | string[] | undefined, fallback: string): string {
  if (!hint) return fallback;
  return Array.isArray(hint) ? hint.join(' | ') : hint;
}

function collectNodeTypes(shapeIR: ShapeIR): Map<string, NodeShape> {
  const out = new Map<string, NodeShape>();
  const walk = (s: RuleShape): void => {
    if (s.kind === 'node') out.set(s.type, s);
    else if (s.kind === 'choice') for (const a of s.arms) walk(a.shape);
    else if (s.kind === 'pratt') {
      for (const k of ['atom', 'group', 'nudSeq', 'nudCapped', 'prefix', 'binary', 'postfix', 'led', 'postfixTok', 'template'] as const) {
        const x = s[k];
        if (x && typeof x === 'object' && 'kind' in x) walk(x as RuleShape);
      }
    }
  };
  for (const r of shapeIR.rules) walk(r.shape);
  return out;
}

function choiceUnionName(ruleName: string, _shape: ChoiceShape): string {
  return ruleName + 'Shape';
}

function prattUnionName(ruleName: string): string {
  return ruleName + 'Shape';
}

function emitShapeTypeDecls(ir: ParserIR, shapeIR: ShapeIR): string {
  const span = shapeSpanFields(shapeIR.spans);
  const nodes = collectNodeTypes(shapeIR);
  const lines: string[] = ['// ─── Shape AST types (generated) ────────────────────────────────────────────'];
  const leafScalars = new Set<string>();
  for (const [tt, pol] of Object.entries(shapeIR.leaves) as [string, TokenLeafPolicy][]) {
    if (pol.action === 'leafValue') {
      const ts = pol.fn === 'number' ? 'number' : pol.fn === 'bigint' ? 'bigint' : pol.fn === 'boolean' ? 'boolean' : 'string';
      leafScalars.add(ts);
    }
  }
  if (leafScalars.size) {
    for (const ts of [...leafScalars].sort()) {
      lines.push(`export type ${ts === 'string' ? 'Identifier' : ts[0]!.toUpperCase() + ts.slice(1)} = ${ts};`);
    }
  }
  for (const [type, node] of [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fields = node.fields.map((f: FieldDecl) => {
      const opt = f.optional ? '?' : '';
      let ty = shapeTsTypeHint(f.typeHint, 'unknown');
      if (f.bind === 'opText') ty = 'string';
      else if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'list') ty = `${ty}[]`;
      return `${f.name}${opt}: ${ty};`;
    }).join(' ');
    lines.push(`export interface ${type} { type: ${J(type)}; ${fields}${fields && span ? ' ' : ''}${span} }`);
  }
  for (const r of shapeIR.rules) {
    if (r.shape.kind === 'choice') {
      const members = r.shape.arms.map((a: ChoiceArm) => {
        if (a.shape.kind === 'node') return a.shape.type;
        if (a.shape.kind === 'list') return `${shapeTsTypeHint(a.shape.elemHint, 'unknown')}[]`;
        return 'unknown';
      });
      const name = choiceUnionName(r.name, r.shape);
      lines.push(`export type ${name} = ${members.join(' | ')};`);
      if (r.name === 'Stmt') lines.push(`export type Statement = ${name};`);
      if (r.name === ir.entry) lines.push(`export type AstRoot = ${name};`);
    } else if (r.shape.kind === 'pratt') {
      const members: string[] = [];
      const add = (s: RuleShape | { kind: 'rule'; name: string } | undefined) => {
        if (!s) return;
        if (s.kind === 'rule') {
          members.push(`${s.name}Shape`);
          return;
        }
        if (s.kind === 'node') members.push(s.type);
        else if (s.kind === 'leafValue') {
          const ts = s.fn === 'number' ? 'number' : s.fn === 'bigint' ? 'bigint' : s.fn === 'boolean' ? 'boolean' : 'string';
          members.push(ts);
        } else if (s.kind === 'keep') {
          for (const [, pol] of Object.entries(shapeIR.leaves) as [string, TokenLeafPolicy][]) {
            if (pol.action === 'leafValue') {
              const ts = pol.fn === 'number' ? 'number' : pol.fn === 'bigint' ? 'bigint' : pol.fn === 'boolean' ? 'boolean' : 'string';
              members.push(ts);
            }
          }
        } else if (s.kind === 'custom') {
          members.push('unknown');
        }
      };
      add(r.shape.atom);
      add(r.shape.prefix);
      add(r.shape.binary);
      add(r.shape.group);
      add(r.shape.led);
      add(r.shape.postfix);
      const uniq = [...new Set(members)];
      const name = prattUnionName(r.name);
      lines.push(`export type ${name} = ${uniq.join(' | ')};`);
      if (r.name === 'Expr') lines.push(`export type Expression = ${name};`);
      if (r.name === ir.entry) lines.push(`export type AstRoot = ${name};`);
    } else if (r.shape.kind === 'node' && r.name === ir.entry) {
      lines.push(`export type AstRoot = ${r.shape.type};`);
    } else if (r.shape.kind === 'list' && r.name === ir.entry) {
      lines.push(`export type AstRoot = ${shapeTsTypeHint(r.shape.elemHint, 'unknown')}[];`);
    }
  }
  if (!lines.some((l) => l.includes('AstRoot'))) {
    lines.push(`export type AstRoot = unknown;`);
  }
  lines.push(`export type AstCustomCtx = { src: string; kids: readonly unknown[]; off: number; end: number; altPath: readonly number[]; opText?: string; left?: unknown; state?: unknown };`);
  lines.push(`export type AstCustoms = Record<string, (ctx: AstCustomCtx) => unknown>;`);
  lines.push('let _astCustoms: AstCustoms = {};');
  return lines.join('\n');
}

function leafDropped(ttype: string, leaves: Record<string, TokenLeafPolicy>): boolean {
  return leaves[ttype]?.action === 'drop';
}

function emitAstNodeCtor(
  node: NodeShape, spans: ShapeSpec['spans'], fields: Array<{ name: string; expr: string }>, offExpr: string, endExpr: string,
): string {
  const spanPart = spans === 'none' ? ''
    : spans === 'required' ? `, off: ${offExpr}, end: ${endExpr}`
    : `, ...( ${offExpr} >= 0 ? { off: ${offExpr}, end: ${endExpr} } : {} )`;
  const body = fields.map((f) => `${f.name}: ${f.expr}`).join(', ');
  return `{ type: ${J(node.type)}, ${body}${spanPart} }`;
}

/** Emit steps: push visible values into `_sk`, bind named fields, honour list/opt binds. */
function emitAstRdAltSteps(
  steps: Step[],
  ids: LexIdPlan,
  leaves: Record<string, TokenLeafPolicy>,
  _bindings: Map<number, string>,
  _listBindings: Map<number, string>,
  _optBindings: Map<number, string>,
  _listElemHints: Map<number, string>,
  ctx: ShapeEmitCtx,
): { ok: string } {
  const visible = (s: Step): boolean => {
    switch (s.t) {
      case 'lit': return !leafDropped(s.ttype, leaves);
      case 'tok': return !leafDropped(s.name, leaves);
      case 'rule':
      case 'ruleBp': return true;
      case 'star': return visible(s.step);
      case 'opt':
      case 'seq':
      case 'suppress':
      case 'ctx': return s.steps.some(visible);
      case 'sep': return visible(s.elem);
      case 'altlit': return s.opts.some((o) => !leafDropped(o.ttype, leaves));
      case 'alt': return s.branches.some((b) => b.some(visible));
      case 'look':
      case 'ahead':
      case 'aheadCtx':
      case 'sameLine': return false;
    }
  };
  const valueOf = (name: string): string => {
    const fn = leaves[name]?.action === 'leafValue' ? leaves[name].fn : 'ident';
    return fn === 'number' ? '_shapeLeafNumber(t)'
      : fn === 'bigint' ? '_shapeLeafBigint(t)'
      : fn === 'boolean' ? '_shapeLeafBoolean(t)'
      : fn === 'string' ? '_shapeLeafString(t)'
      : '_shapeLeafIdent(t)';
  };
  let localId = 0;
  const local = (stem: string): string => `_shape${stem}${localId++}`;
  const emitSteps = (xs: Step[], sink: string): string =>
    xs.length ? xs.map((x) => emitStep(x, sink)).join(' && ') : 'true';
  const emitStep = (s: Step, sink: string): string => {
    ctx.step[s.t]++;
    switch (s.t) {
      case 'lit':
        return leafDropped(s.ttype, leaves)
          ? `_shapeDropLit(${lidOf(ids, s.value)})`
          : `(() => { if (!_shapeKeepLit(${lidOf(ids, s.value)}, ${J(s.ttype)})) return false; ${sink}.push(${J(s.value)}); return true; })()`;
      case 'tok':
        return leafDropped(s.name, leaves)
          ? `_shapeDropTok(${kidOf(ids, s.name)})`
          : `(() => { const t = peek(); if (t === null || t.kid !== ${kidOf(ids, s.name)}) return false; ${sink}.push(${valueOf(s.name)}); pos++; return true; })()`;
      case 'rule':
        return `(() => { const _rv = parseAst${s.name}(); if (_rv === null) return false; ${sink}.push(_rv); return true; })()`;
      case 'ruleBp':
        return `(() => { const _rv = parseAst${s.name}_bp(${s.bp}); if (_rv === null) return false; ${sink}.push(_rv); return true; })()`;
      case 'seq':
        return `(${emitSteps(s.steps, sink)})`;
      case 'sameLine':
        return `(() => { const t = peek(); return t !== null && !t.nl; })()`;
      case 'ahead':
        return `ahead(${s.set}, ${s.is})`;
      case 'aheadCtx':
        return s.is ? `(ahead(${s.set}, true) || ctxWord())` : `(ahead(${s.set}, false) && !ctxWord())`;
      case 'look': {
        const nv = local('Not');
        return `(() => { const ${nv}: unknown[] = []; return ${s.is ? '' : '!'}_shapeProbe(${nv}, _ap, () => ${emitSteps(ctx.look[s.id]!, nv)}); })()`;
      }
      case 'suppress':
        return `(() => { _suppressNext = ${s.set}; const _r = (${emitSteps(s.steps, sink)}); _suppressNext = 0; return _r; })()`;
      case 'ctx':
        return `(() => { const _c = _ctx; _ctx = ${s.ctx}; const _r = (${emitSteps(s.steps, sink)}); _ctx = _c; return _r; })()`;
      case 'altlit': {
        const arms = s.opts.map((o) =>
          `if (t.lid === ${lidOf(ids, o.value)}) { pos++; ${visible(s) ? `${sink}.push(${leafDropped(o.ttype, leaves) ? 'null' : J(o.value)});` : ''} return true; }`,
        ).join(' ');
        return `(() => { const t = peek(); if (t === null) return false; ${arms} return false; })()`;
      }
      case 'alt': {
        const tries = s.branches.map((b, i) => {
          const av = local('Alt');
          return `{ const ${av}: unknown[] = []; if (_shapeTxn(${av}, _ap, () => { _ap.push(${i}); return ${emitSteps(b, av)}; })) { ${visible(s) ? `${sink}.push(_shapePack(${av}));` : ''} return true; } }`;
        }).join(' ');
        return `(() => { ${tries} return false; })()`;
      }
      case 'star': {
        const out = local('StarOut');
        const sv = local('StarValue');
        const body = emitStep(s.step, sv);
        return `(() => { const ${out}: unknown[] = []; for (;;) { const ${sv}: unknown[] = []; if (!_shapeTxn(${sv}, _ap, () => ${body})) break; ${visible(s.step) ? `${out}.push(_shapePack(${sv}));` : ''} } ${visible(s.step) ? `${sink}.push(${out});` : ''} return true; })()`;
      }
      case 'opt': {
        const ov = local('Opt');
        const body = emitSteps(s.steps, ov);
        return `(() => { const ${ov}: unknown[] = []; const _ok = _shapeTxn(${ov}, _ap, () => ${body}); ${s.steps.some(visible) ? `${sink}.push(_ok ? _shapePack(${ov}) : null);` : ''} return true; })()`;
      }
      case 'sep': {
        const out = local('SepOut');
        const ev = local('SepValue');
        const body = emitStep(s.elem, ev);
        const add = visible(s.elem) ? `${out}.push(_shapePack(${ev}));` : '';
        const finish = visible(s.elem) ? `${sink}.push(${out});` : '';
        return `(() => { const ${out}: unknown[] = []; let ${ev}: unknown[] = []; if (!_shapeTxn(${ev}, _ap, () => ${body})) { ${finish} return true; } ${add} for (;;) { const _d = pos; if (!_shapeDropLit(${lidOf(ids, s.delim)})) { pos = _d; break; } ${ev} = []; if (!_shapeTxn(${ev}, _ap, () => ${body})) break; ${add} } ${finish} return true; })()`;
      }
    }
  };
  return {
    ok: `const _ap: number[] = [];\n      if (!_shapeTxn(_sk, _ap, () => ${emitSteps(steps, '_sk')})) { pos = sp; return null; }`,
  };
}

function fieldMaps(node: NodeShape): {
  bindings: Map<number, string>;
  listBindings: Map<number, string>;
  optBindings: Map<number, string>;
  listElemHints: Map<number, string>;
} {
  const bindings = new Map<number, string>();
  const listBindings = new Map<number, string>();
  const optBindings = new Map<number, string>();
  const listElemHints = new Map<number, string>();
  for (const f of node.fields) {
    if (f.bind === 'opText') continue;
    if (isFieldBindObj(f.bind) && 'at' in f.bind) bindings.set(f.bind.at, f.name);
    if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'list' && typeof f.bind.of === 'number') {
      listBindings.set(f.bind.of, f.name);
      if (f.typeHint) listElemHints.set(f.bind.of, shapeTsTypeHint(f.typeHint, 'unknown'));
    }
    if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'opt') {
      optBindings.set(f.bind.at, f.name);
    }
  }
  return { bindings, listBindings, optBindings, listElemHints };
}

function nodeFieldExprs(node: NodeShape): Array<{ name: string; expr: string }> {
  return node.fields.map((f: FieldDecl) => {
    if (f.bind === 'opText') return { name: f.name, expr: `''` };
    if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'list') {
      return { name: f.name, expr: `_sk[${f.bind.of}] as any` };
    }
    if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'opt') {
      // Prefer null over undefined to match toy Guarded golden.
      return { name: f.name, expr: `_sk[${f.bind.at}] as any` };
    }
    if (isFieldBindObj(f.bind) && 'at' in f.bind) return { name: f.name, expr: `_sk[${f.bind.at}] as any` };
    return { name: f.name, expr: 'undefined' };
  });
}

function emitChoiceArmTry(
  r: RdRule,
  arm: ChoiceArm,
  altIdx: number,
  ids: LexIdPlan,
  shapeIR: ShapeIR,
  ctx: ShapeEmitCtx,
  finish: string,
): string {
  const alt = r.alts[altIdx];
  if (!alt) {
    ctx.note(`choice-oob-alt[${altIdx}]`);
    return '';
  }
  const leaves = shapeIR.leaves;
  const guard = astGuard(r, altIdx);

  if (arm.shape.kind === 'node') {
    const maps = fieldMaps(arm.shape);
    const stepsCode = emitAstRdAltSteps(alt, ids, leaves, maps.bindings, maps.listBindings, maps.optBindings, maps.listElemHints, ctx);
    // finish returns the node ctor using field vars
    return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      ${finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk').replaceAll('__SPOFF__', 'spOff')}
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got as any; bestPos = pos; }
    pos = sp;
  } }`;
  }
  if (arm.shape.kind === 'inline') {
    const emptyB = new Map<number, string>();
    const stepsCode = emitAstRdAltSteps(alt, ids, leaves, emptyB, emptyB, emptyB, emptyB, ctx);
    return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      ${finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk').replaceAll('__SPOFF__', 'spOff')}
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got as any; bestPos = pos; }
    pos = sp;
  } }`;
  }
  if (arm.shape.kind === 'custom') {
    const emptyB = new Map<number, string>();
    const stepsCode = emitAstRdAltSteps(alt, ids, leaves, emptyB, emptyB, emptyB, emptyB, ctx);
    return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      ${finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk').replaceAll('__SPOFF__', 'spOff')}
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got as any; bestPos = pos; }
    pos = sp;
  } }`;
  }
  if (arm.shape.kind === 'keep') {
    const emptyB = new Map<number, string>();
    const stepsCode = emitAstRdAltSteps(alt, ids, leaves, emptyB, emptyB, emptyB, emptyB, ctx);
    return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      ${finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk').replaceAll('__SPOFF__', 'spOff')}
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got as any; bestPos = pos; }
    pos = sp;
  } }`;
  }
  if (arm.shape.kind === 'drop' || arm.shape.kind === 'leafValue' || arm.shape.kind === 'list') {
    ctx.note(`choice-arm-${arm.shape.kind}`);
    return `  /* unsupported choice arm ${arm.name} kind=${arm.shape.kind} */`;
  }
  ctx.note(`choice-arm-${(arm.shape as { kind: string }).kind}`);
  return '';
}

// parseAst<rule> chooses among a rule's alternatives as parse<rule> does: longest match in
// declaration order (emit-portable.ts, RdRule) — an alternative is kept only when it ends past
// `bestPos`. A rule with one alternative has nothing to choose, so its match is taken as it is.
const astBestInit = (r: RdRule): string => (r.alts.length > 1 ? 'save' : 'save - 1');
// Emitted between an alternative's steps and its finish: an alternative that does not end past
// the best so far builds nothing, so no custom runs for it.
const AST_NOT_BETTER = 'if (pos <= bestPos) return null;';

function emitAstRdRule(r: RdRule, sir: ShapeIRRule, ids: LexIdPlan, shapeIR: ShapeIR, parentCtx: ShapeEmitCtx, built: boolean): string {
  const ctx = newShapeEmitCtx(r.name, parentCtx.look);
  const leaves = shapeIR.leaves;
  const spans = shapeIR.spans;
  const shape = sir.shape;

  const finalize = (code: string): string => {
    mergeShapeEmitCtx(parentCtx, ctx);
    return code;
  };

  // A rule without a building form (ParserIR.forms) is reached only inside lookaheads, so its AST
  // is only ever made inside a probe, which drops it: it is recognized instead (`true` stands for
  // the value a probe drops).
  if (!built && (shape.kind === 'drop' || shape.kind === 'keep')) {
    return finalize(shape.kind === 'drop'
      ? `function parseAst${r.name}(): null { const sp = pos; if (!parse${r.name}R()) pos = sp; return null; }`
      : `function parseAst${r.name}(): unknown { return parse${r.name}R() ? true : null; }`);
  }
  if (shape.kind === 'drop') {
    return finalize(`function parseAst${r.name}(): null { const sp = pos; if (!_drop(_n, parse${r.name}W())) pos = sp; return null; }`);
  }
  if (shape.kind === 'custom') {
    const tries = r.alts.map((alt, ai) => {
      const guard = astGuard(r, ai);
      const emptyB = new Map<number, string>();
      const stepsCode = emitAstRdAltSteps(alt, ids, leaves, emptyB, emptyB, emptyB, emptyB, ctx);
      const folds = J(shape.folds ?? []);
      return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      const end = pos > 0 ? toks[pos - 1]!.end : spOff;
      const fn = _astCustoms[${J(shape.fn)}];
      if (!fn) throw new Error('shape: custom ${shape.fn} not provided');
      const _fold = _shapeFoldKids(_sk, ${folds});
      return fn({ src: _src, kids: _fold.kids, off: spOff, end, altPath: [${ai}, ..._ap]${shape.folds?.length ? ', state: _fold.state' : ''} });
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got; bestPos = pos; }
    pos = sp;
  } }`;
    }).join('\n');
    const needPeek = r.altGuard.some((g) => g !== null);
    return finalize(`function parseAst${r.name}(): unknown {
  const save = pos;
  let best: unknown = null, bestPos = ${astBestInit(r)};
${needPeek ? '  const _ft = peek();\n' : ''}${tries}
  pos = bestPos;
  return best;
}`);
  }
  if (shape.kind === 'inline') {
    return finalize(`function parseAst${r.name}(): unknown { throw new Error('shape: inline ${r.name} must be spliced by parent'); }`);
  }
  if (shape.kind === 'list') {
    const inner = r.alts[0]?.[0];
    const elemRule = inner?.t === 'star' && inner.step.t === 'rule' ? inner.step.name : null;
    if (!elemRule) {
      ctx.note('list-unsupported-IR');
      return finalize(`function parseAst${r.name}(): unknown[] { throw new Error('shape: list ${r.name} unsupported IR'); }`);
    }
    ctx.step.star++;
    ctx.step.rule++;
    const elemHint = shapeTsTypeHint(shape.elemHint, 'unknown');
    return finalize(`function parseAst${r.name}(): ${elemHint}[] | null {
  const sp = pos;
  const out: ${elemHint}[] = [];
  for (;;) {
    const sp2 = pos;
    const el = parseAst${elemRule}();
    if (el === null) { pos = sp2; break; }
    out.push(el);
  }
  if (pos === sp && out.length === 0) return null;
  return out;
}`);
  }
  if (shape.kind === 'keep') {
    return finalize(`function parseAst${r.name}(): unknown {
  const b = _n;
  if (!parse${r.name}W()) return null;
  const cst = _hs[b]; _n = b;   // the CST builder's node, taken off the stack
  return { type: ${J(r.name)}, children: cst };
}`);
  }
  if (shape.kind === 'leafValue') {
    ctx.note('rd-leafValue');
    return finalize(`function parseAst${r.name}(): unknown { throw new Error('shape: leafValue on RD ${r.name}'); }`);
  }
  if (shape.kind === 'choice') {
    const retType = choiceUnionName(r.name, shape);
    const armTries: Array<{ altIdx: number; code: string }> = [];
    for (const arm of shape.arms) {
      let finish: string;
      if (arm.shape.kind === 'node') {
        const maps = fieldMaps(arm.shape);
        // Declare field vars from maps; fields already assigned during steps via var ${bind}
        const decls = [
          ...[...maps.bindings.values()].map((n) => `/* field ${n} via bind */`),
          ...[...maps.listBindings.values()].map((n) => `/* list ${n} */`),
          ...[...maps.optBindings.values()].map((n) => `/* opt ${n} */`),
        ].join(' ');
        const ctor = emitAstNodeCtor(arm.shape, spans, nodeFieldExprs(arm.shape), '__SPOFF__', 'pos > 0 ? toks[pos - 1]!.end : __SPOFF__');
        finish = `${decls}\n    return ${ctor};`;
      } else if (arm.shape.kind === 'inline') {
        // Return the single visible kid (or last) after drops.
        finish = `if (__SK__.length === 1) return __SK__[0]; if (__SK__.length === 0) return null; return __SK__;`;
      } else if (arm.shape.kind === 'custom') {
        finish = `{
      const end = pos > 0 ? toks[pos - 1]!.end : __SPOFF__;
      const fn = _astCustoms[${J(arm.shape.fn)}];
      if (!fn) throw new Error('shape: custom ${arm.shape.fn} not provided');
      const _fold = _shapeFoldKids(__SK__, ${J(arm.shape.folds ?? [])});
      return fn({ src: _src, kids: _fold.kids, off: __SPOFF__, end, altPath: [__ALT__, ..._ap]${arm.shape.folds?.length ? ', state: _fold.state' : ''} });
    }`;
      } else if (arm.shape.kind === 'keep') {
        finish = `return { type: ${J(r.name)}, children: __SK__, arm: ${J(arm.name)}, alt: __ALT__ };`;
      } else {
        finish = `return null;`;
      }
      for (const altIdx of arm.altIndices) {
        armTries.push({ altIdx, code: emitChoiceArmTry(r, arm, altIdx, ids, shapeIR, ctx, finish) });
      }
    }
    const armBlocks = armTries.sort((x, y) => x.altIdx - y.altIdx).map((x) => x.code);
    const needPeek = r.altGuard.some((g) => g !== null);
    return finalize(`function parseAst${r.name}(): ${retType} | null {
  const save = pos;
  let best: ${retType} | null = null, bestPos = ${astBestInit(r)};
${needPeek ? '  const _ft = peek();\n' : ''}${armBlocks.filter(Boolean).join('\n')}
  pos = bestPos;
  return best;
}`);
  }
  if (shape.kind === 'node') {
    const node = shape;
    // Multi-alt node: try each alt with shared finish (true backtrack).
    const maps = fieldMaps(node);
    const ctor = emitAstNodeCtor(node, spans, nodeFieldExprs(node), 'spOff', 'pos > 0 ? toks[pos - 1]!.end : spOff');
    if (r.alts.length === 1) {
      const stepsCode = emitAstRdAltSteps(r.alts[0]!, ids, leaves, maps.bindings, maps.listBindings, maps.optBindings, maps.listElemHints, ctx);
      return finalize(`function parseAst${r.name}(): ${node.type} | null {
  const sp = pos;
  const spOff = sp < toks.length ? toks[sp]!.off : 0;
  const _sk: unknown[] = [];
  ${stepsCode.ok}
  return ${ctor};
}`);
    }
    const tries = r.alts.map((alt, ai) => {
      const guard = astGuard(r, ai);
      const stepsCode = emitAstRdAltSteps(alt, ids, leaves, maps.bindings, maps.listBindings, maps.optBindings, maps.listElemHints, ctx);
      return `  { const sp = pos; const spOff = sp < toks.length ? toks[sp]!.off : 0; if (${guard}) {
    const _got = (() => {
      const _sk: unknown[] = [];
      ${stepsCode.ok}
      ${AST_NOT_BETTER}
      return ${ctor};
    })();
    if (_got !== null && _got !== undefined && pos > bestPos) { best = _got; bestPos = pos; }
    pos = sp;
  } }`;
    }).join('\n');
    const needPeek = r.altGuard.some((g) => g !== null);
    return finalize(`function parseAst${r.name}(): ${node.type} | null {
  const save = pos;
  let best: ${node.type} | null = null, bestPos = ${astBestInit(r)};
${needPeek ? '  const _ft = peek();\n' : ''}${tries}
  pos = bestPos;
  return best;
}`);
  }
  if (shape.kind === 'pratt') {
    ctx.note('pratt-on-rd');
  }
  return finalize(`function parseAst${r.name}(): unknown { throw new Error('shape: unsupported RD shape for ${r.name}'); }`);
}

function emitAstPrattRule(r: PrattRule, sir: ShapeIRRule, ids: LexIdPlan, shapeIR: ShapeIR, parentCtx: ShapeEmitCtx, ir: ParserIR): string {
  const ctx = newShapeEmitCtx(r.name, parentCtx.look);
  const finalize = (code: string): string => {
    mergeShapeEmitCtx(parentCtx, ctx);
    return code;
  };
  // Bare keep on a Pratt IR rule → empty pratt shape (all slots default keep).
  let shape: RuleShape = sir.shape;
  if (shape.kind === 'keep') shape = { kind: 'pratt' };
  if (shape.kind !== 'pratt') {
    ctx.note('expected-pratt-shape');
    return finalize(`function parseAst${r.name}(): unknown { throw new Error('shape: expected pratt shape'); }`);
  }
  const ps = shape;
  const retType = prattUnionName(r.name);
  const spans = shapeIR.spans;
  const leaves = shapeIR.leaves;
  const tpl = ir.tpl;
  const emptyB = new Map<number, string>();

  const spanObj = (off: string, end: string) =>
    spans === 'none' ? ''
      : spans === 'required' ? `, off: ${off}, end: ${end}`
      : `, ...( ${off} >= 0 ? { off: ${off}, end: ${end} } : {} )`;
  const spanKeep = (off: string, end: string) =>
    spans === 'none' ? '' : `, off: ${off}, end: ${end}`;

  /** Missing Pratt slot → keep (positional), matching RD unmapped default. */
  const slotOf = (declared: { kind: string } | undefined, present: boolean): { kind: string } | null => {
    if (!present) return null;
    return declared ?? { kind: 'keep' };
  };

  const txnInner = (steps: Step[], armCtx: ShapeEmitCtx): string => {
    const emit = emitAstRdAltSteps(steps, ids, leaves, emptyB, emptyB, emptyB, emptyB, armCtx);
    const m = emit.ok.match(/_shapeTxn\(_sk, _ap, \(\) => ([\s\S]*)\)\) \{ pos = sp; return null; \}/);
    return m ? m[1]! : 'true';
  };

  const keepFinish = (kidsExpr: string, saveExpr: string) =>
    `{ type: ${J(r.name)}, children: ${kidsExpr}, headText: _shapeHeadText(${kidsExpr}[0])${spanKeep(
      `${saveExpr} < toks.length ? toks[${saveExpr}]!.off : 0`,
      `pos > 0 ? toks[pos - 1]!.end : (${saveExpr} < toks.length ? toks[${saveExpr}]!.off : 0)`,
    )} }`;

  const customFinish = (
    fn: string, kidsExpr: string, saveExpr: string, altExpr: string,
    leftExpr?: string, opTextExpr?: string,
  ) =>
    `(() => { const _fn = _astCustoms[${J(fn)}]; if (!_fn) throw new Error(${J('shape: custom ' + fn + ' not provided')});`
    + ` const _off = ${saveExpr} < toks.length ? toks[${saveExpr}]!.off : 0;`
    + ` const _end = pos > 0 ? toks[pos - 1]!.end : _off;`
    + ` return _fn({ src: _src, kids: ${kidsExpr}, off: _off, end: _end, altPath: ${altExpr}${opTextExpr ? `, opText: ${opTextExpr}` : ''}${leftExpr ? `, left: ${leftExpr}` : ''} }); })()`;

  const nodeFieldsFromSk = (node: NodeShape, leftExpr?: string): Array<{ name: string; expr: string }> =>
    node.fields.map((f: FieldDecl) => {
      if (f.bind === 'opText') return { name: f.name, expr: 'opText' };
      if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'list') {
        return { name: f.name, expr: `_sk[${f.bind.of}] as any` };
      }
      if (isFieldBindObj(f.bind) && 'from' in f.bind && f.bind.from === 'opt') {
        return { name: f.name, expr: `_sk[${f.bind.at}] as any` };
      }
      if (isFieldBindObj(f.bind) && 'at' in f.bind) {
        if (leftExpr && f.bind.at === 0) return { name: f.name, expr: leftExpr };
        if (leftExpr) return { name: f.name, expr: `_sk[${f.bind.at - 1}] as any` };
        return { name: f.name, expr: `_sk[${f.bind.at}] as any` };
      }
      return { name: f.name, expr: 'undefined' };
    });

  const leafValExpr = (tok: string, tVar = 't'): string => {
    const pol = leaves[tok];
    if (pol?.action === 'leafValue') {
      if (pol.fn === 'number') return `_shapeLeafNumber(${tVar})`;
      if (pol.fn === 'bigint') return `_shapeLeafBigint(${tVar})`;
      if (pol.fn === 'boolean') return `_shapeLeafBoolean(${tVar})`;
      if (pol.fn === 'string') return `_shapeLeafString(${tVar})`;
      return `_shapeLeafIdent(${tVar})`;
    }
    return `_shapeLeafIdent(${tVar})`;
  };

  /** Explicit pratt.template only — omitted means legacy `$template` (hole = caller rule). */
  const templateSlot = ps.template as CustomShape | KeepShape | undefined;
  const hasTplNud = r.nudTplHole !== undefined;
  const hasTplPostfix = r.postfixTplHole !== undefined;
  if (templateSlot && (hasTplNud || hasTplPostfix)) ctx.pratt.template++;

  /** Finish kids from matchTemplateAstKids / no-subst leaf via template slot. */
  const templateFinish = (kidsExpr: string, saveExpr: string): string => {
    if (!templateSlot || templateSlot.kind === 'keep') {
      return `{ type: ${J('$template')}, children: ${kidsExpr}, headText: _shapeHeadText(${kidsExpr}[0])${spanKeep(
        `${saveExpr} < toks.length ? toks[${saveExpr}]!.off : 0`,
        `pos > 0 ? toks[pos - 1]!.end : (${saveExpr} < toks.length ? toks[${saveExpr}]!.off : 0)`,
      )} }`;
    }
    return customFinish(templateSlot.fn, kidsExpr, saveExpr, '[]');
  };

  // ── atom ──────────────────────────────────────────────────────────────────
  // One arm per atom token (its place in PrattRule.nudOrder); '' when the shape maps no atom.
  ctx.pratt.atom++;
  const atomArm = (tok: string): string => {
    const k = kidOf(ids, tok);
    if (ps.atom?.kind === 'rule') return `  if (t.kid === ${k} && save + 1 > bestPos) {\n    return parseAst${ps.atom.name}() as ${retType};\n  }`;
    if (ps.atom?.kind === 'custom') {
      return `  if (t.kid === ${k} && save + 1 > bestPos) {
    const spOff = t.off; const leafKids: unknown[] = [${leafValExpr(tok)}];
    pos++;
    const fn = _astCustoms[${J(ps.atom.fn)}];
    if (!fn) throw new Error('shape: custom ${ps.atom.fn} not provided');
    return fn({ kids: leafKids, altPath: [], src: _src, off: spOff, end: t.end }) as ${retType};
  }`;
    }
    if (!ps.atom || ps.atom.kind === 'drop') return '';
    const atomShape = ps.atom;
    const pol = leaves[tok];
    if (tpl && tok === tpl.token && templateSlot) {
      return `  if (t.kid === ${k} && save + 1 > bestPos) { const save = pos; const _lv = ${leafValExpr(tok)}; pos++; return ${templateFinish('[_lv]', 'save')} as ${retType}; }`;
    }
    if (atomShape.kind === 'leafValue') {
      const fn = atomShape.fn === 'number' ? '_shapeLeafNumber'
        : atomShape.fn === 'ident' ? '_shapeLeafIdent'
        : atomShape.fn === 'bigint' ? '_shapeLeafBigint'
        : atomShape.fn === 'boolean' ? '_shapeLeafBoolean'
        : '_shapeLeafString';
      return `  if (t.kid === ${k} && save + 1 > bestPos) { pos++; return ${fn}(t) as ${retType}; }`;
    }
    if (pol?.action === 'leafValue') {
      return `  if (t.kid === ${k} && save + 1 > bestPos) { pos++; return ${leafValExpr(tok)} as ${retType}; }`;
    }
    return `  if (t.kid === ${k} && save + 1 > bestPos) { const save = pos; const _lv = ${leafValExpr(tok)}; pos++; return ${keepFinish('[_lv]', 'save')} as ${retType}; }`;
  };

  // ── template NUD ──────────────────────────────────────────────────────────
  // Each hole is parsed, and its AST produced, by the rule the matching reference declares
  // (PrattRule.nudTplHole / postfixTplHole) ≡ CST matchTemplate.
  let tplNudCode = '';
  if (hasTplNud) {
    if (templateSlot) {
      tplNudCode = `  if (t.kid === ${kidOf(ids, '$templateHead')}) {
    const _tm = matchTemplateAstKids(parseAst${r.nudTplHole});
    if (_tm === null || pos <= bestPos) return undefined;
    return ${templateFinish('_tm.kids', '_tm.save')} as ${retType};
  }
`;
    } else {
      tplNudCode = `  if (t.kid === ${kidOf(ids, '$templateHead')}) {
    const node = matchTemplateAstLegacy(parseAst${r.nudTplHole});
    if (node === null || pos <= bestPos) return undefined;
    return node as ${retType};
  }
`;
    }
  }

  // ── group / nudBrackets ───────────────────────────────────────────────────
  const groupSlot = slotOf(ps.group as { kind: string } | undefined, r.nudBrackets.length > 0);
  let bracketArms: string[] = [];
  if (groupSlot && r.nudBrackets.length > 0) {
    ctx.pratt.group += r.nudBrackets.length;
    {
      bracketArms = r.nudBrackets.map((b, bi) => {
        const armCtx = newShapeEmitCtx(r.name, ctx.look);
        const inner = txnInner(b.steps, armCtx);
        mergeShapeEmitCtx(ctx, armCtx);
        let finish: string;
        if (groupSlot.kind === 'inline') {
          finish = `if (_sk.length === 1) return _sk[0] as ${retType}; if (_sk.length === 0) return null; return _sk as unknown as ${retType};`;
        } else if (groupSlot.kind === 'custom') {
          finish = `return ${customFinish((groupSlot as CustomShape).fn, '_sk', 'save', `[${bi}]`)} as ${retType};`;
        } else if (groupSlot.kind === 'node') {
          const node = groupSlot as NodeShape;
          finish = `return ${emitAstNodeCtor(node, spans, nodeFieldsFromSk(node), 'save < toks.length ? toks[save]!.off : 0', 'pos > 0 ? toks[pos - 1]!.end : (save < toks.length ? toks[save]!.off : 0)')} as ${retType};`;
        } else {
          finish = `return ${keepFinish('_sk', 'save')} as ${retType};`;
        }
        return `  if (t.lid === ${lidOf(ids, b.first)}) {
        const save = pos;
        const _sk: unknown[] = [];
        const _ap: number[] = [];
        if (_shapeTxn(_sk, _ap, () => ${inner}) && pos > bestPos) {
          ${r.nudBracketClosesTail[bi] ? 'pt = true; ' : ''}${finish}
        }
        pos = save;
      }`;
      });
    }
  }

  // ── prefix ────────────────────────────────────────────────────────────────
  const prefixSlot = slotOf(ps.prefix as { kind: string } | undefined, r.prefix.length > 0);
  let prefixCode = '';
  if (prefixSlot) {
    ctx.pratt.prefix += Math.max(1, r.prefix.length);
    if (prefixSlot.kind === 'node') {
      const prefixNode = prefixSlot as NodeShape;
      prefixCode = `  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    const opText = _src.slice(t.off, t.end);
    pos++;
    const argument = parseAst${r.name}_bp(pbp);
    if (argument === null) { pos = save; return undefined; }
    if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { hard = true; return undefined; }
    if (pos <= bestPos) return undefined;
    pf = ${r.name}_PRE_FORM[t.lid]!; pt = true;
    const spOff = save < toks.length ? toks[save]!.off : 0;
    const end = pos > 0 ? toks[pos - 1]!.end : spOff;
    const _sk: unknown[] = [argument];
    return ${emitAstNodeCtor(prefixNode, spans, nodeFieldsFromSk(prefixNode), 'spOff', 'end')} as ${retType};
  }`;
    } else if (prefixSlot.kind === 'custom') {
      prefixCode = `  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    const opText = _src.slice(t.off, t.end);
    pos++;
    const argument = parseAst${r.name}_bp(pbp);
    if (argument === null) { pos = save; return undefined; }
    if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { hard = true; return undefined; }
    if (pos <= bestPos) return undefined;
    pf = ${r.name}_PRE_FORM[t.lid]!; pt = true;
    return ${customFinish((prefixSlot as CustomShape).fn, '[argument]', 'save', '[]', undefined, 'opText')} as ${retType};
  }`;
    } else if (prefixSlot.kind === 'inline') {
      prefixCode = `  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    pos++;
    const argument = parseAst${r.name}_bp(pbp);
    if (argument === null) { pos = save; return undefined; }
    if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { hard = true; return undefined; }
    if (pos <= bestPos) return undefined;
    pf = ${r.name}_PRE_FORM[t.lid]!; pt = true;
    return argument;
  }`;
    } else {
      prefixCode = `  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    const opText = _src.slice(t.off, t.end);
    pos++;
    const argument = parseAst${r.name}_bp(pbp);
    if (argument === null) { pos = save; return undefined; }
    if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { hard = true; return undefined; }
    if (pos <= bestPos) return undefined;
    pf = ${r.name}_PRE_FORM[t.lid]!; pt = true;
    return ${keepFinish('[opText, argument]', 'save')} as ${retType};
  }`;
    }
  }

  // ── nudSeq ────────────────────────────────────────────────────────────────
  const nudSeqSlot = slotOf(ps.nudSeq as { kind: string } | undefined, r.nudSeqs.length > 0);
  let seqArms: string[] = [];
  if (nudSeqSlot) {
    ctx.pratt.nudSeq += r.nudSeqs.length;
    seqArms = r.nudSeqs.map((seq, si) => {
      const armCtx = newShapeEmitCtx(r.name, ctx.look);
      const inner = txnInner(seq, armCtx);
      mergeShapeEmitCtx(ctx, armCtx);
      let finish: string;
      if (nudSeqSlot.kind === 'custom') {
        finish = `return ${customFinish((nudSeqSlot as CustomShape).fn, '_sk', 'save', `[${si}]`)} as ${retType};`;
      } else if (nudSeqSlot.kind === 'node') {
        const node = nudSeqSlot as NodeShape;
        finish = `return ${emitAstNodeCtor(node, spans, nodeFieldsFromSk(node), 'save < toks.length ? toks[save]!.off : 0', 'pos > 0 ? toks[pos - 1]!.end : (save < toks.length ? toks[save]!.off : 0)')} as ${retType};`;
      } else if (nudSeqSlot.kind === 'inline') {
        finish = `if (_sk.length === 1) return _sk[0] as ${retType}; if (_sk.length === 0) return null; return _sk as unknown as ${retType};`;
      } else {
        finish = `return ${keepFinish('_sk', 'save')} as ${retType};`;
      }
      return `  { const save = pos; const _sk: unknown[] = []; const _ap: number[] = []; if (_shapeTxn(_sk, _ap, () => ${inner}) && pos > bestPos) { ${r.nudSeqClosesTail[si] ? 'pt = true; ' : ''}${finish} } pos = save; }`;
    });
  }

  // ── nudCapped ─────────────────────────────────────────────────────────────
  const nudCappedSlot = slotOf(ps.nudCapped as { kind: string } | undefined, r.nudCapped.length > 0);
  let cappedArms: string[] = [];
  if (nudCappedSlot) {
    ctx.pratt.nudCapped += r.nudCapped.length;
    cappedArms = r.nudCapped.map((c, ci) => {
      const armCtx = newShapeEmitCtx(r.name, ctx.look);
      const inner = txnInner(c.steps, armCtx);
      mergeShapeEmitCtx(ctx, armCtx);
      let finish: string;
      if (nudCappedSlot.kind === 'custom') {
        finish = `return ${customFinish((nudCappedSlot as CustomShape).fn, '_sk', 'save', `[${ci}]`)} as ${retType};`;
      } else if (nudCappedSlot.kind === 'node') {
        const node = nudCappedSlot as NodeShape;
        finish = `return ${emitAstNodeCtor(node, spans, nodeFieldsFromSk(node), 'save < toks.length ? toks[save]!.off : 0', 'pos > 0 ? toks[pos - 1]!.end : (save < toks.length ? toks[save]!.off : 0)')} as ${retType};`;
      } else if (nudCappedSlot.kind === 'inline') {
        finish = `if (_sk.length === 1) return _sk[0] as ${retType}; if (_sk.length === 0) return null; return _sk as unknown as ${retType};`;
      } else {
        finish = `return ${keepFinish('_sk', 'save')} as ${retType};`;
      }
      return `  if (minBp < ${c.capBp}) { const save = pos; const _sk: unknown[] = []; const _ap: number[] = []; if (_shapeTxn(_sk, _ap, () => ${inner}) && pos > bestPos) { pc = true; ${finish} } pos = save; }`;
    });
  }

  // ── NUD selection ─────────────────────────────────────────────────────────
  // Longest match over the arms in declaration order (emit-portable.ts, PrattRule.nudOrder),
  // as the CST parser does. Each arm's code returns its value when it matches and falls out
  // otherwise; it is tried from `save`, and kept only when it ends past the best so far.
  // `hard` is the prefix arm's "operand is not the target the operator requires": the whole
  // Pratt call fails.
  const tryArm = (code: string): string => code === '' ? '' : `  { pf = 0; pt = false; pc = false;
    const _a = ((): ${retType} | null | undefined => {
${code}
      return undefined;
    })();
    if (hard) { pos = save; _capped = false; return null; }
    if (_a !== null && _a !== undefined && pos > bestPos) { best = _a; bestPos = pos; bf = pf; bt = pt; bc = pc; }
    pos = save; }`;
  const guarded = (g: Guard, arm: string): string => { const c = guardCond(g, 't', false); return arm !== '' && c.length ? `  if (${c.join(' && ')}) {\n${arm}\n  }` : arm; };
  const nudArm = (a: NudRef): string => {
    switch (a.kind) {
      case 'tok': {
        const tok = r.nudToks[a.index]!;
        return [tryArm(atomArm(tok)), tpl && tok === tpl.token ? tryArm(tplNudCode) : ''].filter(Boolean).join('\n');
      }
      case 'bracket': return tryArm(bracketArms[a.index] ?? '');
      case 'seq': return guarded(r.nudSeqGuard[a.index]!, tryArm(seqArms[a.index] ?? ''));
      case 'capped': return guarded(r.nudCappedGuard[a.index]!, tryArm(cappedArms[a.index] ?? ''));
      case 'prefix': return tryArm(prefixCode);
    }
  };

  // ── binary / postfix / postfixTok / led slots ─────────────────────────────
  const binarySlot = slotOf(ps.binary as { kind: string } | undefined, r.binary.length > 0);
  if (binarySlot) ctx.pratt.binary += Math.max(1, r.binary.length);
  const postfixSlot = slotOf(ps.postfix as { kind: string } | undefined, r.postfix.length > 0);
  if (postfixSlot) ctx.pratt.postfix += r.postfix.length;
  const postfixTokSlot = slotOf(ps.postfixTok as { kind: string } | undefined, r.postfixToks.length > 0);
  if (postfixTokSlot) ctx.pratt.postfixTok += r.postfixToks.length;
  const ledSlot = slotOf(ps.led as { kind: string } | undefined, r.leds.length > 0);
  if (ledSlot) ctx.pratt.led += r.leds.length;

  const ledGuard = (i: number) => {
    const parts: string[] = [];
    if (r.ledAccessTail[i]) parts.push('!tailClosed');
    if (r.ledLbp[i] !== null && r.ledLbp[i] !== undefined) parts.push(`${r.ledLbp[i]} > minBp`);
    if (r.ledSameLine[i]) parts.push('!t.nl');
    if (r.ledNotLeftLeaf[i]) parts.push(`!${J(r.ledNotLeftLeaf[i])}.includes(_shapeHeadText(left))`);
    for (const set of r.ledSuppressedIn[i]!) parts.push(`_suppressCur !== ${set}`);
    return parts.length ? `if (${parts.join(' && ')}) ` : '';   // the `if` before the led's block; none when nothing gates it
  };
  // A lid that ALSO has a binary entry (`<` is both a type-arg LED and the
  // relational operator) must fall through to the binary check on LED failure
  // (CST / interpreter parity). Multiple arms sharing a lid fall through to
  // each other; only the LAST arm of a group emits `break ledLoop`.
  const binLids = new Set(r.binary.map((b) => lidOf(ids, b.op)));

  let ledSwitch = '';
  if (ledSlot && r.leds.length > 0) {
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    const cases = groups.map((g) => {
      const lid = g.key as number;
      const hasBin = binLids.has(lid);
      const arms = g.members.map(({ item: b, index: i }, j) => {
        const armCtx = newShapeEmitCtx(r.name, ctx.look);
        const inner = txnInner(b.steps, armCtx);
        mergeShapeEmitCtx(ctx, armCtx);
        let finish: string;
        if (ledSlot.kind === 'custom') {
          finish = `left = ${customFinish((ledSlot as CustomShape).fn, '_sk', 'ledSave', `[${i}]`, 'left', 'opText')} as ${retType};`;
        } else if (ledSlot.kind === 'node') {
          const ledNode = ledSlot as NodeShape;
          // Visible _sk after drops; at:0 binds left (LED callee / receiver).
          finish = `{ const spOff = leftOff; const end = pos > 0 ? toks[pos - 1]!.end : spOff;
          left = ${emitAstNodeCtor(ledNode, spans, nodeFieldsFromSk(ledNode, 'left'), 'spOff', 'end')} as ${retType};
          leftOff = spOff; leftEnd = end; }`;
        } else if (ledSlot.kind === 'inline') {
          finish = `{ left = (_sk.length === 1 ? _sk[0] : _sk) as ${retType}; leftEnd = pos > 0 ? toks[pos - 1]!.end : leftOff; }`;
        } else {
          finish = `{ const _kids = [left, ..._sk]; left = ${keepFinish('_kids', 'ledSave')} as ${retType}; leftEnd = pos > 0 ? toks[pos - 1]!.end : leftOff; }`;
        }
        return `      ${ledGuard(i)}{
        const ledSave = pos;
        const opText = _src.slice(t.off, t.end);
        const _cappedSave = _capped;
        const _sk: unknown[] = [];
        const _ap: number[] = [];
        if (_shapeTxn(_sk, _ap, () => ${inner})) {
          ${finish}
          form = ${r.ledForm[i]!};${r.ledClosesTail[i] ? ' tailClosed = true;' : ''}
          continue ledLoop;
        }
        pos = ledSave;
        _capped = _cappedSave;
${hasBin ? '' : (j === g.members.length - 1 ? '        break ledLoop;' : '')}
      }`;
      }).join('\n');
      return `      case ${lid}:\n${arms}\n        break;`;
    }).join('\n');
    ledSwitch = `    switch (t.lid) {\n${cases}\n    }`;
  }

  let postfixTokSwitch = '';
  if (postfixTokSlot && r.postfixToks.length > 0) {
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = hasTplPostfix;
    const cases = groups.map((g) => {
      const tokName = r.postfixToks.find((t) => kidOf(ids, t) === g.key)!;
      let finish: string;
      if (postfixTokSlot.kind === 'custom') {
        finish = `left = ${customFinish((postfixTokSlot as CustomShape).fn, '[leaf]', 'leftTokStart', '[]', 'left', '_src.slice(t.off, t.end)')} as ${retType};`;
      } else if (postfixTokSlot.kind === 'node') {
        const node = postfixTokSlot as NodeShape;
        finish = `{ const spOff = leftOff; const end = t.end;
          left = ${emitAstNodeCtor(node, spans, node.fields.map((f: FieldDecl) => {
            if (isFieldBindObj(f.bind) && 'at' in f.bind && f.bind.at === 0) return { name: f.name, expr: 'left' };
            if (isFieldBindObj(f.bind) && 'at' in f.bind && f.bind.at === 1) return { name: f.name, expr: 'leaf' };
            return { name: f.name, expr: 'left' };
          }), 'spOff', 'end')} as ${retType}; leftOff = spOff; leftEnd = end; }`;
      } else {
        finish = `{ const _kids = [left, leaf]; left = ${keepFinish('_kids', 'leftTokStart')} as ${retType}; leftEnd = t.end; }`;
      }
      const leafInit = (tpl && tokName === tpl.token && templateSlot)
        ? `const leftTokStart = pos; const _lv = ${leafValExpr(tokName)}; const leaf = ${templateFinish('[_lv]', 'leftTokStart')}; pos++;`
        : `const leaf = ${leafValExpr(tokName)}; const leftTokStart = pos; pos++;`;
      return `      case ${g.key}:
        if (!tailClosed) {
          ${leafInit}
          ${finish}
          form = 0;
          continue ledLoop;
        }
        break;`;
    }).join('\n');
    let tplFinish: string;
    if (postfixTokSlot.kind === 'custom') {
      tplFinish = `left = ${customFinish((postfixTokSlot as CustomShape).fn, '[node]', 'leftTokStart', '[]', 'left', '_src.slice(node_off, node_end)')} as ${retType};`;
    } else if (postfixTokSlot.kind === 'node') {
      const node = postfixTokSlot as NodeShape;
      tplFinish = `{ const spOff = leftOff; const end = pos > 0 ? toks[pos - 1]!.end : leftOff;
          left = ${emitAstNodeCtor(node, spans, node.fields.map((f: FieldDecl) => {
            if (isFieldBindObj(f.bind) && 'at' in f.bind && f.bind.at === 0) return { name: f.name, expr: 'left' };
            if (isFieldBindObj(f.bind) && 'at' in f.bind && f.bind.at === 1) return { name: f.name, expr: 'node' };
            return { name: f.name, expr: 'left' };
          }), 'spOff', 'end')} as ${retType}; leftOff = spOff; leftEnd = end; }`;
    } else {
      tplFinish = `{ const _kids = [left, node]; left = ${keepFinish('_kids', 'leftTokStart')} as ${retType}; leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd; }`;
    }
    let tplPart = '';
    if (hasTpl) {
      if (templateSlot) {
        tplPart = `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) {
      const leftTokStart = pos;
      const node_off = t.off;
      const _tm = matchTemplateAstKids(parseAst${r.postfixTplHole});
      if (_tm !== null) {
        const node = ${templateFinish('_tm.kids', '_tm.save')};
        const node_end = pos > 0 ? toks[pos - 1]!.end : node_off;
        ${tplFinish}
        leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd;
        form = 0;
        continue ledLoop;
      }
    }`;
      } else {
        tplPart = `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) {
      const leftTokStart = pos;
      const node_off = t.off;
      const node = matchTemplateAstLegacy(parseAst${r.postfixTplHole});
      const node_end = pos > 0 ? toks[pos - 1]!.end : node_off;
      if (node !== null) {
        ${tplFinish}
        leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd;
        form = 0;
        continue ledLoop;
      }
    }`;
      }
    }
    postfixTokSwitch = `    switch (t.kid) {\n${cases}\n    }${tplPart}`;
  }

  let postfixCode = '';
  if (postfixSlot) {
    if (postfixSlot.kind === 'node') {
      const node = postfixSlot as NodeShape;
      postfixCode = `    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) return null;
      const opText = _src.slice(t.off, t.end);
      pos++;
      const spOff = leftOff;
      const end = t.end;
      const _sk: unknown[] = [left];
      left = ${emitAstNodeCtor(node, spans, nodeFieldsFromSk(node), 'spOff', 'end')} as ${retType};
      leftOff = spOff; leftEnd = end;
      tailClosed = true; form = 1; continue;
    }`;
    } else if (postfixSlot.kind === 'custom') {
      postfixCode = `    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) return null;
      const opText = _src.slice(t.off, t.end);
      const save = pos; pos++;
      left = ${customFinish((postfixSlot as CustomShape).fn, '[]', 'save', '[]', 'left', 'opText')} as ${retType};
      leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd;
      tailClosed = true; form = 1; continue;
    }`;
    } else {
      postfixCode = `    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) return null;
      const opText = _src.slice(t.off, t.end);
      const save = pos; pos++;
      const _kids = [left, opText];
      left = ${keepFinish('_kids', 'save')} as ${retType};
      leftEnd = t.end;
      tailClosed = true; form = 1; continue;
    }`;
    }
  }

  // Binary `$ op $` path must NOT consult `_suppressCur` — exclude/suppress only
  // disables literal-headed LEDs (e.g. `[$, 'in', $]`), matching CST / interpreter.
  let binaryCode = '    break;';
  if (binarySlot) {
    if (binarySlot.kind === 'node') {
      const binaryNode = binarySlot as NodeShape;
      binaryCode = `    const info = ${r.name}_BIN[_opLid(t)];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) return null;
    const ledSave = pos;
    const opText = _src.slice(t.off, _opEnd);
    pos += _opN;
    const right = parseAst${r.name}_bp(info.rbp);
    if (right === null) { pos = ledSave; break; }
    const spOff = leftOff;
    const end = pos > 0 ? toks[pos - 1]!.end : spOff;
    const _sk: unknown[] = [left, right];
    left = ${emitAstNodeCtor(binaryNode, spans, nodeFieldsFromSk(binaryNode), 'spOff', 'end')} as ${retType};
    leftOff = spOff;
    leftEnd = end;`;
    } else if (binarySlot.kind === 'custom') {
      binaryCode = `    const info = ${r.name}_BIN[_opLid(t)];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) return null;
    const ledSave = pos;
    const opText = _src.slice(t.off, _opEnd);
    pos += _opN;
    const right = parseAst${r.name}_bp(info.rbp);
    if (right === null) { pos = ledSave; break; }
    left = ${customFinish((binarySlot as CustomShape).fn, '[right]', 'ledSave', '[]', 'left', 'opText')} as ${retType};
    leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd;`;
    } else {
      binaryCode = `    const info = ${r.name}_BIN[_opLid(t)];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) return null;
    const ledSave = pos;
    const opText = _src.slice(t.off, _opEnd);
    pos += _opN;
    const right = parseAst${r.name}_bp(info.rbp);
    if (right === null) { pos = ledSave; break; }
    const _kids = [left, opText, right];
    left = ${keepFinish('_kids', 'ledSave')} as ${retType};
    leftEnd = pos > 0 ? toks[pos - 1]!.end : leftEnd;`;
    }
  }

  const hasLedLoop = !!(ledSwitch || postfixTokSwitch || postfixCode);

  // Capped NUD returns early with _capped=true BEFORE the IIFE (CST oracle).
  // Non-capped path forces _capped=false after the IIFE — only the capped arms above produce a capped node.
  return finalize(`function parseAst${r.name}(): ${retType} | null {
  const prev = _suppressCur;
  _suppressCur = _suppressNext;
  _suppressNext = 0;
  const r = parseAst${r.name}_bp(0);
  _suppressCur = prev;
  return r;
}
function parseAst${r.name}_bp(minBp: number): ${retType} | null {
  let left = parseAst${r.name}_nud(minBp);
  if (left === null) return null;
  let form = _form;
  if (_capped) return left;
  let leftOff = (typeof left === 'object' && left !== null && 'off' in left && typeof (left as { off?: number }).off === 'number')
    ? (left as { off: number }).off
    : (pos > 0 ? toks[Math.max(0, pos - 1)]!.off : 0);
  let leftEnd = (typeof left === 'object' && left !== null && 'end' in left && typeof (left as { end?: number }).end === 'number')
    ? (left as { end: number }).end
    : (pos > 0 ? toks[pos - 1]!.end : leftOff);
  let tailClosed = _tail;
  ${hasLedLoop ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;
${ledSwitch}
${postfixTokSwitch}
${postfixCode}
${binaryCode}${binarySlot ? '\n    form = 1; tailClosed = true;' : ''}
  }
  _form = form;
  return left;
}
function parseAst${r.name}_nud(minBp: number): ${retType} | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
  const save = pos;
  let best: ${retType} | null = null, bestPos = save, bf = 0, bt = false, bc = false;
  let pf = 0, pt = false, pc = false, hard = false;   // set by the arm being tried
${r.nudOrder.map(nudArm).filter(Boolean).join('\n')}
  _capped = bc;
  _form = bf;
  _tail = bt;
  pos = bestPos;
  return best;
}`);
}

function emitShapeParseHelpers(ir: ParserIR, ids: LexIdPlan): string {
  const tpl = ir.tpl;
  // Shape template kids helper. CST matchTemplate is untouched (byte-identical).
  // interp: the rule that parses each hole and yields its AST — the one the matching
  // reference declares (≡ CST matchTemplate).
  const tplHelper = tpl ? `function _shapeTplSnap(): { pos: number; capped: boolean; sn: number; sc: number } {
  return { pos, capped: _capped, sn: _suppressNext, sc: _suppressCur };
}
function _shapeTplRestore(s: { pos: number; capped: boolean; sn: number; sc: number }): void {
  pos = s.pos; _capped = s.capped; _suppressNext = s.sn; _suppressCur = s.sc;
}
function matchTemplateAstKids(interp: () => unknown | null): { kids: unknown[]; save: number } | null {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return null;
  const kids: unknown[] = [];
  const save = pos;
  const saveSnap = _shapeTplSnap();
  kids.push(_shapeLeafString(t));
  pos++;
  for (;;) {
    const holeAst = interp();
    if (holeAst === null) { _shapeTplRestore(saveSnap); return null; }
    kids.push(holeAst);
    const next = peek();
    if (next === null) { _shapeTplRestore(saveSnap); return null; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) {
      kids.push(_shapeLeafString(next));
      pos++;
      continue;
    }
    if (next.kid === ${kidOf(ids, '$templateTail')}) {
      kids.push(_shapeLeafString(next));
      pos++;
      break;
    }
    _shapeTplRestore(saveSnap);
    return null;
  }
  return { kids, save };
}
function matchTemplateAstLegacy(interp: () => unknown | null): unknown | null {
  const _tm = matchTemplateAstKids(interp);
  if (_tm === null) return null;
  const off = _tm.save < toks.length ? toks[_tm.save]!.off : 0;
  const end = pos > 0 ? toks[pos - 1]!.end : off;
  return { type: '$template', children: _tm.kids, headText: _shapeHeadText(_tm.kids[0]), off, end };
}
` : '';
  return `// ─── Shape parse helpers ─────────────────────────────────────────────────────
function _shapeDropLit(lid: number): boolean {
  if (_GT_LIT[lid] !== 0) return _matchComp(lid);
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  pos++; return true;
}
function _shapeKeepLit(lid: number, _tt: string): boolean {
  if (_GT_LIT[lid] !== 0) return _matchComp(lid);
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  pos++; return true;
}
function _shapeDropTok(kid: number): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  pos++; return true;
}
function _shapeKeepTok(kid: number): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  pos++; return true;
}
function _shapeLeafNumber(t: Tok): number { return Number(_src.slice(t.off, t.end)); }
function _shapeLeafIdent(t: Tok): string { return _src.slice(t.off, t.end); }
function _shapeLeafString(t: Tok): string { return _src.slice(t.off, t.end); }
function _shapeLeafBigint(t: Tok): bigint { const s = _src.slice(t.off, t.end); return BigInt(s.endsWith('n') ? s.slice(0, -1) : s); }
function _shapeLeafBoolean(t: Tok): boolean { return _src.slice(t.off, t.end) === 'true'; }
function _shapePack(values: unknown[]): unknown {
  return values.length === 0 ? null : values.length === 1 ? values[0] : values.slice();
}
/** Head-leaf text for notLeftLeaf guards (CST headLeafText analogue). */
function _shapeHeadText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.headText === 'string' && o.headText.length > 0) return o.headText;
    // Unary / Update: CST first child is the operator leaf.
    if (typeof o.operator === 'string' && 'argument' in o && !('left' in o) && !('right' in o)) return o.operator;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.value === 'string' || typeof o.value === 'number' || typeof o.value === 'bigint') return String(o.value);
    if ('left' in o) return _shapeHeadText(o.left);
    if ('callee' in o) return _shapeHeadText(o.callee);
    if (Array.isArray(o.children) && o.children.length > 0) return _shapeHeadText(o.children[0]);
    if ('argument' in o) return _shapeHeadText(o.argument);
    if ('expression' in o) return _shapeHeadText(o.expression);
  }
  return '';
}
/** Transaction boundary for every speculative RD/Pratt body. */
function _shapeTxn(kids: unknown[], altPath: number[], body: () => boolean): boolean {
  const sp = pos;
  const kk = kids.length;
  const ak = altPath.length;
  const sn = _suppressNext;
  const cap = _capped;
  if (body()) return true;
  pos = sp;
  kids.length = kk;
  altPath.length = ak;
  _suppressNext = sn;
  _capped = cap;
  return false;
}
/** Zero-width trial: restore all recognizer state whether the body succeeds or fails. */
function _shapeProbe(kids: unknown[], altPath: number[], body: () => boolean): boolean {
  const sp = pos;
  const kk = kids.length;
  const ak = altPath.length;
  const sn = _suppressNext;
  const cap = _capped;
  const ok = body();
  pos = sp;
  kids.length = kk;
  altPath.length = ak;
  _suppressNext = sn;
  _capped = cap;
  return ok;
}
/** sepBy aligned with CST: zero elements ok; trailing delimiter consumed. */
function _shapeSepRule(elem: () => unknown | null, delimLid: number, out: unknown[]): boolean {
  const first = elem();
  if (first === null) return true;
  out.push(first);
  for (;;) {
    const sp = pos;
    if (!_shapeDropLit(delimLid)) { pos = sp; break; }
    const el = elem();
    if (el === null) break; // trailing delimiter — keep consumed delim, stop
    out.push(el);
  }
  return true;
}

function _shapeIsPartial(v: unknown): v is { __shapePartial: string; mode: 'start' | 'append'; value: unknown } {
  return typeof v === 'object' && v !== null && '__shapePartial' in (v as object);
}
function _shapeFoldList(
  list: unknown[],
  folds: { tag: string; into: string }[],
  state: Record<string, { starts: number; appends: number }>,
): unknown[] {
  const byTag = new Map(folds.map((f) => [f.tag, f.into]));
  const out: unknown[] = [];
  for (const k of list) {
    if (_shapeIsPartial(k) && byTag.has(k.__shapePartial)) {
      const into = byTag.get(k.__shapePartial)!;
      if (k.mode === 'start') {
        state[k.__shapePartial]!.starts++;
        out.push(k.value);
      } else if (k.mode === 'append') {
        const prev = out[out.length - 1];
        if (prev === null || prev === undefined || typeof prev !== 'object') {
          throw new Error('shape: partial append has no preceding start for ' + k.__shapePartial);
        }
        const p = prev as Record<string, unknown>;
        let arr = p[into];
        if (!Array.isArray(arr)) { arr = []; p[into] = arr; }
        (arr as unknown[]).push(k.value);
        state[k.__shapePartial]!.appends++;
      }
      continue;
    }
    if (Array.isArray(k)) { out.push(_shapeFoldList(k, folds, state)); continue; }
    out.push(k);
  }
  return out;
}
/** Fold child partial markers per parent custom folds spec (recursive into list slots). */
function _shapeFoldKids(kids: unknown[], folds: { tag: string; into: string }[]): {
  kids: unknown[];
  state?: Record<string, { starts: number; appends: number }>;
} {
  if (!folds.length) return { kids };
  const state = Object.fromEntries(folds.map((f) => [f.tag, { starts: 0, appends: 0 }]));
  return { kids: _shapeFoldList(kids, folds, state), state };
}
${tplHelper}`;
}

function emitShapeCoverageExport(cov: ShapeEmitCtx): string {
  return `export const shapeCoverage = ${J({
    step: cov.step,
    pratt: cov.pratt,
    unsupported: cov.unsupported,
  })} as const;
`;
}

function emitShapeAstAddon(ir: ParserIR, shapeIR: ShapeIR, ids: LexIdPlan): string {
  const cov = newShapeEmitCtx('(aggregate)', ir.lookaheads);
  const fns = shapeIR.rules.map((sir: ShapeIRRule) => {
    const r = ir.rules.find((x) => x.name === sir.name);
    if (!r) return '';
    if (r.kind === 'pratt') return emitAstPrattRule(r, sir, ids, shapeIR, cov, ir);
    return emitAstRdRule(r, sir, ids, shapeIR, cov, ir.forms.buildRules.includes(r.name));
  }).filter(Boolean).join('\n\n');

  if (cov.unsupported.length > 0) {
    const lines = cov.unsupported.map((u) => `  ${u.rule}: ${u.construct}`);
    throw new Error(
      `shape emit: ${cov.unsupported.length} unsupported construct(s):\n${lines.join('\n')}`,
    );
  }

  const entry = ir.entry;
  const rootType = 'AstRoot';
  return `
${emitShapeTypeDecls(ir, shapeIR)}

${emitShapeParseHelpers(ir, ids)}

${fns}

${emitShapeCoverageExport(cov)}

// ─── Shape parseAst entry ────────────────────────────────────────────────────
export function parseAst(src: string, opts?: { customs?: AstCustoms }): ${rootType} | null {
  _astCustoms = opts?.customs ?? {};
  _src = src;
  toks = lex(src);
  pos = 0;
  // The engine runs under the typed layer where it builds nothing it keeps: a dropped rule, a
  // Pratt rule inside a lookahead (ParserIR.forms).
  _builder = cstBuilder; _n = 0;
  const root = parseAst${entry}();
  return root !== null && pos === toks.length ? (root as ${rootType}) : null;
}
`;
}

const TS_TYPES: Record<Ty, string> = {
  int: 'number', lid: 'number', depth: 'number', pos: 'number', idx: 'number', bool: 'boolean', str: 'string', meta: 'AlignMeta', tok: 'Tok', edit: 'Edit',
  metas: 'AlignMeta[]', toks: 'Tok[]', bools: 'boolean[]', depths: 'number[]', edits: 'Edit[]',
};
// Operator spelling and binding strength; unary is 90, a negative literal 7.
const TS_OPS: Record<BinOp, [string, number]> = {
  or: ['||', 1], and: ['&&', 2], eq: ['===', 3], ne: ['!==', 3], lt: ['<', 4], le: ['<=', 4], gt: ['>', 4], ge: ['>=', 4], shr: ['>>', 5], shl: ['<<', 5], add: ['+', 6], sub: ['-', 6],
};
const TS_IND = '  ';
const tsWrap = (r: R, min: number): string => (r.prec < min ? `(${r.c})` : r.c);
const tsBlock = (lines: string[]): string[] => lines.map((l) => TS_IND + l);

// Shared-algorithm lowering: untyped numbers, GC-managed arrays (capacity is never reserved).
const tsLowering: Lowering = {
  units: UNITS,
  ident: (n) => n,
  num: { int: 'number', lid: 'number', depth: 'number', pos: 'number', idx: 'number' },
  type: (t) => (isRecList(t) ? `${recName(t)}[]` : isRec(t) ? recName(t) : isOpt(t) ? `${recName(t)} | null` : TS_TYPES[t]),
  owns: false,
  charSet: (name, rs) => `const ${name} = /*#__PURE__*/ (() => { const a = new Uint8Array(256); for (const [lo, hi] of [${rs.map(([lo, hi]) => `[${lo},${hi}]`).join(', ')}]) for (let i = lo; i <= hi; i++) a[i] = 1; return a; })();`,
  // A code unit past 255 indexes no table entry (undefined), so it ends the run.
  // A unit loop: Rust's four-per-round shape did not pay in V8 (measure-targets, PR #138: ts-parse
  // -3.9% to +2.6%, ts-parseWith +0.7% to +2.6%, within the 3% noise floor).
  runEndFn: `// The end of the run of code units in set from i: the first j >= i at which s ends or s[j] is not in it.
function lexRunEnd(s: string, i: number, set: Uint8Array): number {
  while (i < s.length && set[s.charCodeAt(i)] === 1) i++;
  return i;
}`,
  findFn: `// Where lit next occurs in s from i: the first j >= i at which s has it, or s.length.
function lexFind(s: string, i: number, lit: string): number {
  const k = s.indexOf(lit, i);
  return k < 0 ? s.length : k;
}`,
  // One code unit per round, compared with each stop: no allocation, no regular expression.
  findAnyFn: (stops) => `// Where the next of ${stops.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')} is in s from i, or s.length.
function ${findAnyName(stops)}(s: string, i: number): number {
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (${stops.map((c) => `c === ${c}`).join(' || ')}) return i;
  }
  return s.length;
}`,
  expr: {
    literal: (v) => ({ c: typeof v === 'string' ? JSON.stringify(v) : String(v), prec: typeof v === 'number' && v < 0 ? 7 : ATOM }),
    not: (r) => ({ c: `!${tsWrap(r, ATOM)}`, prec: 90 }),
    bin: (op, a, b) => {
      const [sp, p] = TS_OPS[op];
      const side = (r: R, right: boolean): string =>
        (r.prec < p || (right && r.prec === p) || ((op === 'shr' || op === 'shl') && r.prec < ATOM) || (COMPARISON.has(op) && r.prec >= 3 && r.prec <= 4) ? `(${r.c})` : r.c);
      return { c: `${side(a, false)} ${sp} ${side(b, true)}`, prec: p };
    },
    call: (name, args) => `${name}(${args.join(', ')})`,
    len: (cx, l) => cx.atom(`${tsWrap(l, ATOM)}.length`, 'int', 'number'),
    code: (cx, s, i) => cx.atom(`${tsWrap(s, ATOM)}.charCodeAt(${i.c})`, 'int', 'number'),
    hasAt: (cx, s, i, lit) => cx.atom(`${tsWrap(s, ATOM)}.startsWith(${J(lit)}, ${i.c})`, 'bool', 'bool'),
    inSet: (_cx, set, c) => ({ c: `${set}[${c.c}] === 1`, ty: 'bool', nat: 'bool', prec: TS_OPS.eq[1] }),
    runEnd: (cx, set, s, i) => cx.atom(`lexRunEnd(${s.c}, ${i.c}, ${set})`, 'int', 'number'),
    find: (cx, s, i, lit) => cx.atom(`lexFind(${s.c}, ${i.c}, ${J(lit)})`, 'int', 'number'),
    findAny: (cx, s, i, stops) => cx.atom(`${findAnyName(stops)}(${s.c}, ${i.c})`, 'int', 'number'),
    own: (_cx, r) => r,
  },
  stmt: {
    comment: (text) => [`// ${text}`],
    let: (cx, s) => [`${s.reassigned ? 'let' : 'const'} ${s.id}: ${cx.type(s.ty, 'local')} = ${s.r.c};`],
    set: (id, val) => [`${id} = ${val};`],
    if: (s) => {
      const head = `if (${s.c})`;
      if (s.inline !== undefined && TS_IND.length * s.depth + head.length + 1 + s.inline.length <= 110) return [`${head} ${s.inline}`];
      return [`${head} {`, ...tsBlock(s.then), ...(s.else ? ['} else {', ...tsBlock(s.else)] : []), '}'];
    },
    while: (c, body) => [`while (${c}) {`, ...tsBlock(body), '}'],
    break: () => ['break;'],
    run: (call) => `${call};`,
    return: (vals) => [`return ${vals.length === 1 ? vals[0] : `[${vals.join(', ')}]`};`],
    fn: (f) => [
      ...f.doc.map((l) => `// ${l}`),
      `function ${f.name}(${f.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): ${f.rets.length === 0 ? 'void' : f.rets.length === 1 ? f.rets[0] : `[${f.rets.join(', ')}]`} {`,
      ...tsBlock(f.body),
      '}',
    ].join('\n'),
  },
  relex: {
    index: 'number',
    expr: {
      index: (l, i) => ({ c: `${tsWrap(l, ATOM)}[${i.c}]`, prec: ATOM }),
      metaInt: (cx, m, f) => cx.atom(`${tsWrap(m, ATOM)}.${f}`, 'int', 'number'),
      metaFlag: (cx, m, f) => cx.atom(`am_${f}(${m.c})`, 'bool', 'bool'),
      tokInt: (cx, t, f) => cx.atom(`${tsWrap(t, ATOM)}.${f}`, 'int', 'number'),
      tokNl: (cx, t) => cx.atom(`${tsWrap(t, ATOM)}.nl`, 'bool', 'bool'),
      editInt: (cx, e, f) => cx.atom(`${e.c}.${f}`, 'int', 'number'),
      editText: (cx, e) => cx.atom(`${e.c}.text`, 'str', 'str'),
      metaText: (cx, t, m) => cx.atom(`am_text(${t.c}, ${m.c})`, 'str', 'str'),
      substr: (cx, s, a, b) => cx.atom(`${tsWrap(s, ATOM)}.slice(${a.c}, ${b.c})`, 'str', 'str'),
      lidOf: (cx, s) => cx.atom(`lid_of(${s.c})`, 'lid', cx.nat('lid')),
      mkMeta: (cx, fs) => cx.atom(`mk_align(${fs.map(([, r]) => r.c).join(', ')})`, 'meta', 'meta'),
      shiftMeta: (cx, m, d) => cx.atom(`shift_align(${m.c}, ${d.c})`, 'meta', 'meta'),
      metaEq: (_cx, a, b) => ({
        c: ['off', 'end', 'kid', 'pd', 'fd', 'flags', 'td'].map((f) => `${a.c}.${f} === ${b.c}.${f}`).join(' && '),
        ty: 'bool', nat: 'bool', prec: TS_OPS.and[1],
      }),
      splice: (_cx, s, a, b, ins) => ({ c: `${tsWrap(s, ATOM)}.slice(0, ${a.c}) + ${ins.c} + ${tsWrap(s, ATOM)}.slice(${b.c})`, ty: 'str', nat: 'str', prec: TS_OPS.add[1] }),
      newList: (cx, ty) => cx.atom('[]', ty, ty, { owned: true }),
      falses: (cx, n) => cx.atom(`new Array<boolean>(${n.c}).fill(false)`, 'bools', 'bools', { owned: true }),
      prefix: (cx, l, n) => cx.atom(`${tsWrap(l, ATOM)}.slice(0, ${n.c})`, l.ty, l.ty, { owned: true }),
    },
    stmt: {
      setAt: (id, i, val) => [`${id}[${i}] = ${val};`],
      push: (_cx, l, r) => [`${l}.push(${r.c});`],
      for: (_cx, v, from, to, body) => [`for (let ${v} = ${from.c}; ${v} < ${to.c}; ${v}++) {`, ...tsBlock(body), '}'],
      forEach: (v, l, body) => [`for (const ${v} of ${l}) {`, ...tsBlock(body), '}'],
      destructure: (_cx, s) => {
        const pat = `[${s.names.map((n) => (n === '_' ? '' : n)).join(', ').replace(/(, )+$/, '')}]`;
        if (!s.declare) return [`${pat} = ${s.call};`];
        return [`${s.names.some((n) => s.reassigned(n)) ? 'let' : 'const'} ${pat} = ${s.call};`];
      },
      lexStep: (_cx, s) => [`({ ${[s.posName === 'pos' ? 'pos' : `pos: ${s.posName}`, ...s.state, s.err === 'err' ? 'err' : `err: ${s.err}`].join(', ')} } = lexFrom(${s.text.c}, ${s.pos}, ${[...s.state, s.out].join(', ')}, 1));`],
      lexAll: (_cx, s) => [`const [${s.out}, ${s.err}] = lexAll(${s.text.c});`],
    },
  },  record: {
    field: (cx, r, _rec, f, ty, nat) => cx.atom(`${tsWrap(r, ATOM)}.${f}`, ty, nat),
    setField: (id, f, val) => [`${id}.${f} = ${val};`],
    make: (cx, rec, fs) => cx.atom(`{ ${fs.map(([f, v]) => `${f}: ${v}`).join(', ')} }`, `rec_${rec}`, `rec_${rec}`, { owned: true }),
    refType: (rec) => rec,
    refArg: (r) => r.c,
    copy: (cx, r) => cx.atom(`{ ...${r.c} }`, r.ty, r.nat, { owned: true }),
    none: (cx, rec) => cx.atom('null', `opt_${rec}`, `opt_${rec}`),
    some: (cx, rec, r) => cx.atom(r.c, `opt_${rec}`, `opt_${rec}`, { prec: r.prec }),
    isSome: (_cx, r) => ({ c: `${tsWrap(r, 4)} !== null`, prec: 3 }),
    // One push per element: a spread passes one argument per element (the engine's argument limit).
    extend: (_cx, l, from) => [`for (const el of ${from.c}) ${l}.push(el);`],
  },
};

// No callee-FIRST body guards: a JS rd call refused at its dispatch costs less than the guard's test
// on every iteration (measured: TS blocks +0.19% to +0.53% on the real inputs with them).
const FACTS: PortableFacts = { calleeFirstGuards: false };

export const tsTarget = defineTarget({
  name: 'typescript',
  ext: 'ts',
  lowering: tsLowering,
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string {
    const ir = portableIR(grammar, FACTS);
    return emitTsLibrary(ir, buildLexIdPlan(ir), shared);
  },
  emitRunner,
});

// '>'-led composite operators (ir.gtComps): the lexer scans every '>' alone. Where an operator or a
// composite literal is read, a lone '>' extends over each adjacent single-character punct token
// after it while the text stays a composite. _opLid returns the lid read at token pos (peeked as
// t), its token count in _opN and its end offset in _opEnd; the reads count toward maxLook.
function gtRuntime(ir: ParserIR, ids: LexIdPlan): string {
  const lits = new Array<number>(ids.lids.length).fill(0);
  for (const c of ir.gtComps) lits[lidOf(ids, c)] = 1;
  const head = `const _GT_LIT = Uint8Array.from([${lits.join(',')}]);
let _opN = 1, _opEnd = 0;`;
  if (ir.gtComps.length === 0) {
    return `${head}
function _opLid(t: Tok): number { _opN = 1; _opEnd = t.end; return t.lid; }
function _matchComp(_lid: number): boolean { return false; }`;
  }
  return `${head}
const _GT_COMP: Record<string, number> = { ${ir.gtComps.map((c) => `${J(c)}: ${lidOf(ids, c)}`).join(', ')} };
function _opLid(t: Tok): number {
  _opN = 1; _opEnd = t.end;
  if (t.lid !== ${lidOf(ids, '>')}) return t.lid;
  let lid = t.lid;
  for (let j = pos + 1; j < toks.length; j++) {
    const u = toks[j];
    if (u.kid !== 0 || u.off !== _opEnd || u.end !== u.off + 1) break;
    const c = _GT_COMP[_src.slice(t.off, u.end)];
    if (c === undefined) break;
    lid = c; _opN++; _opEnd = u.end;
  }
  maxLook = Math.max(maxLook, pos + _opN + 1);
  return lid;
}
function _matchComp(lid: number): boolean {
  const t = peek();
  if (t === null || _opLid(t) !== lid) return false;
  pos += _opN; return true;
}`;
}

// The `ahead` test: whether the next token is in tokenSets[k] (see tokenSetBits), compared with `is`.
function tokenSetRuntime(ir: ParserIR, ids: LexIdPlan): string {
  const b = tokenSetBits(ids, ir.tokenSets);
  return `const _SET_WIDTH = ${b.width};
const _SET_KID = ${b.kidBase};
const _SETS = new Uint32Array([${b.words.join(', ')}]);
function inSet(k: number, t: Tok): boolean {
  const w = k >>> 5;
  return (((_SETS[t.lid * _SET_WIDTH + w]! | _SETS[(_SET_KID + t.kid) * _SET_WIDTH + w]!) >>> (k & 31)) & 1) === 1;
}
function ahead(k: number, is: boolean): boolean {
  const t = peek();
  return t === null ? !is : inSet(k, t) === is;
}
// Whether the next token is a word the context in force reserves (ParserIR.ctxWords): with the
// \`ahead\` test of the guard's own set, an \`aheadCtx\` test. Outside every context it reads nothing.
function ctxWord(): boolean {
  if (_ctx === 0) return false;
  const t = peek();
  return t !== null && inCtxWords(t);
}
// Whether t is a word the context in force reserves (a guard's lead test reads the buffered token).
function inCtxWords(t: Tok): boolean {
  return _ctx !== 0 && (false${ctxWordLids(ir, ids).map((w) => ` || ((_ctx & ${w.bit}) !== 0 && t.lid === ${w.lid})`).join('')});
}
// Whether the token after the current one is in set k (a longest-match candidate's SECOND guard).
function secondIn(k: number): boolean {
  maxLook = Math.max(maxLook, pos + 2);
  return pos + 1 < toks.length && inSet(k, toks[pos + 1]!);
}`;
}

function emitTsLibrary(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
    return `// GENERATED by emit-portable.ts (tsTarget) — parser LIBRARY for grammar "${ir.grammarName}" (exports \`tokenize\` + \`parse\`).
// The CLI runner (stdin → CST JSON) is a SEPARATE piece — tsTarget.emitRunner(), appended by the harness.

type Tok = { off: number; end: number; nl: boolean; kid: number; lid: number };
export type Token = { kind: string; text: string; off: number; end: number; nl: boolean; kid: number; lid: number };
// The CST is spans over the source: a leaf's text is src.slice(offset, end). Token indices are
// parse bookkeeping (a composed '>'-led operator spans several tokens, and incremental reuse
// shifts them), so they are not part of it.
export type Leaf = { tokenType: string; offset: number; end: number };
export type Node = { rule: string; children: Cst[]; offset: number; end: number };
export type Cst = Node | Leaf;

${TS_LEX_ERR}${lexer(ir, ids, shared)}

let toks: Tok[] = [];
let pos = 0;
// An entry's extent (EntryMeta.ext): one past the furthest token its parse examined. A read past
// the current token (secondIn, a composed '>') records into maxLook at once; a peek records only
// peekEnd, one past its token. Between two moves back the position only grows, so the latest peek
// is the furthest since the last move back: back() folds it into maxLook before the position
// returns, and lookEnd() folds in the stretch since. Every move of the position to an earlier
// token goes through back().
let maxLook = 0;
let peekEnd = 0;
let _capped = false;
let _form = 0;   // assignment-target form of the node the last _nud/_bp call returned
let _tail = false;   // whether the node the last _nud call returned closes the access tail
// A NUD that matched nothing, from its commit switch: the state its frame leaves then.
function nudNone(): boolean { _capped = false; _form = 0; _tail = false; return false; }
// Indices into the grammar's suppress sets (ParserIR.suppressSets; 0 = none): the set a \`suppress\`
// step stages for the next Pratt call, and the set in force in the current one.
let _suppressNext = 0;
let _suppressCur = 0;
// The [Await]/[Yield] context word in force (ParserIR's Ctx: bit 1 await, bit 2 yield). A \`ctx\` step
// sets it for its body and puts back what it found, so outside every such body it is 0.
let _ctx = 0;
let _src = '';
function peek(): Tok | null { peekEnd = pos + 1; return pos < toks.length ? toks[pos] : null; }
// Move the position back to sp (sp <= pos), first folding the abandoned stretch's furthest peek into maxLook.
function back(sp: number): void { if (peekEnd > maxLook) maxLook = peekEnd; pos = sp; }
// One past the furthest token the current entry examined.
function lookEnd(): number { return peekEnd > maxLook ? peekEnd : maxLook; }
// Start recording an entry's extent.
function lookReset(): void { maxLook = 0; peekEnd = 0; }
${tokenSetRuntime(ir, ids)}
${gtRuntime(ir, ids)}
${engineRuntime(ir, ids)}
// Library entry. tokenize(src) is the lexer alone: fresh Token objects the caller owns, and no
// parser state touched. parse(src) lexes and parses; the CST is plain objects, independent of
// any later call. No I/O — see emitRunner() for the stdin → JSON wrapper.
export function tokenize(src: string): Token[] {
  return lex(src).map((t) => ({ kind: tok_kind(t), text: tok_text(src, t), off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid }));
}
export function parse(src: string): Cst | null {
  _src = src;
  return parseTokens(lex(src));
}
// The entry rule over a token list of the CURRENT _src, with the CST builder.
function parseTokens(tokens: Tok[]): Cst | null {
  toks = tokens;
  return runW(cstBuilder);
}

${docEditBlock(ir, shared)}
${docRuntime(ir)}
// The lifted steps (lift), printed after every site that names one.
${liftedFns(ids)}`;
}

function emitRunner(): string {
    return `// CLI runner (harness only): stdin → CST JSON. Appended to the parser library by the gate;
// NOT part of the emitted parser. The import is hoisted, so it may follow the library code.
import { readFileSync } from 'node:fs';
const _raw = readFileSync(0, 'utf8');
const _editFast = process.argv.includes('edit-session-fast');
const _cstJSON = (n: Cst) => JSON.stringify(n);
if (_editFast || process.argv.includes('edit-session')) {
  const { init, batches } = JSON.parse(_raw) as { init: string; batches: [number, number, string][][] };
  const doc = createDoc(init, { validate: !_editFast });
  for (const batch of batches) doc.edit(batch.map(([start, end, text]) => ({ start, end, text })));
  const a = doc.align();
  if (a) process.stderr.write(JSON.stringify(a) + '\\n');
  const root = doc.root();
  if (root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  process.stdout.write(_cstJSON(root));
} else if (process.argv.includes('tok-spans')) {
  // Parse-consumption spans via a builder reading the parser cursor (pos / _bSave).
  type _Span = { name: string; s: number; e: number; kids: _Span[] };
  const _root = parseWith<_Span>(_raw, {
    leaf: (tokenType) => (tokenType === '$punct' ? null : { name: tokenType, s: pos, e: pos + 1, kids: [] }),
    node: (rule, children) => ({ name: rule, s: _bSave, e: pos, kids: children }),
  });
  if (_root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  for (const k of _root.kids) process.stdout.write(k.name + '\\t' + k.s + '\\t' + k.e + '\\n');
  process.stdout.write('total\\t0\\t' + pos + '\\n');
} else {
  const _root = parse(_raw);
  if (_root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  process.stdout.write(_cstJSON(_root));
}
`;
}

/** Emit TS parser; optional shape appends AST types + specialized parseAst. Without shape, byte-identical to tsTarget.emitParser(grammar). */
export function emitTs(grammar: CstGrammar, opts?: { shape?: ShapeSpec }): string {
  const ir = portableIR(grammar, FACTS);
  const ids = buildLexIdPlan(ir);
  const base = emitTsLibrary(ir, ids, tsTarget.shared);
  if (!opts?.shape) return base;
  return base + emitShapeAstAddon(ir, validateShapeOrThrow(grammar, opts.shape), ids);
}
