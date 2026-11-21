// The TypeScript Target for emit-portable. Renders the language-agnostic ParserIR into a
// self-contained TS parser: a char-class/string/comment lexer, a backtracking recursive-
// descent core, a Pratt expression engine (prefix + binary precedence + mixfix call/member/
// index LEDs), and a CST→JSON printer over stdin. It is the reference rendering — its CST
// is checked byte-for-byte against the interpreter (createParser), so a divergence in the
// portable logic surfaces here before Go/Rust are compiled.
import { type ParserIR, type RdRule, type PrattRule, type NudRef, type Step, type Alt, type Bracket, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type Guard, type Dispatch, type LexFirstBytes, type LexIdPlan } from './emit-portable.ts';
import { portableIR, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, lidOf, kidOf, lidFlagTable, kidFlagTable, isFirstGuardable, groupByPreserveOrder, tokenSetBits } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import type {
  ShapeSpec, ShapeIR, FieldBind, FieldDecl, NodeShape, ChoiceShape, ChoiceArm,
  RuleShape, TokenLeafPolicy, ShapeIRRule, CustomShape, KeepShape,
} from './shape-schema.ts';
import { validateShapeOrThrow } from './shape-validate.ts';
import { defineTarget, type SharedAlgorithms } from './define-target.ts';
import { ATOM, COMPARISON, type BinOp, type Lowering, type R, type Ty } from './algo-ir.ts';
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
  g === null ? [] : [...(keyed ? [] : [`inSet(${g.first.id}, ${t})`]), ...(g.second !== null ? [`secondIn(${g.second.id})`] : [])];
// `if (<conds>) <body>` as one statement (just the body when there is no condition).
const ifTs = (conds: string[], body: string) => (conds.length ? `  if (${conds.join(' && ')}) ${body}` : `  ${body}`);
// A candidate list's Dispatch over the buffered token t: arm(i, keyed) is candidate i's statement.
// nilable: t may be null (no token left), which no key matches.
const dispatchTs = (d: Dispatch, t: string, ids: LexIdPlan, arm: (i: number, keyed: boolean) => string, nilable = false): string =>
  d.sections.map((sec) => {
    if (sec.by === 'rest') return sec.arms.map((i) => arm(i, false)).join('\n');
    const id = (k: string) => (sec.by === 'lid' ? lidOf(ids, k) : kidOf(ids, k));
    const sw = `  switch (${t}.${sec.by}) {\n${sec.groups.map((g) => `  case ${id(g.key)}:\n${g.arms.map((i) => arm(i, true)).join('\n')}\n  break;`).join('\n')}\n  }`;
    return nilable ? `  if (${t} !== null) {\n${sw}\n  }` : sw;
  }).join('\n');
// Whether candidate i, just ended at pos, beats the best so far: it ends past it, or — a Dispatch
// `ranked` candidate — ties it and was declared earlier. `bi` (the best one's index) is kept only
// in a list that has ranked candidates.
const beatsTs = (d: Dispatch, pos: string, i: number) => d.ranked.includes(i) ? `(${pos} > bestPos || ${pos} === bestPos && ${i} < bi)` : `${pos} > bestPos`;
const markTs = (d: Dispatch, i: number) => (d.ranked.length ? ` bi = ${i};` : '');
const biTs = (d: Dispatch) => (d.ranked.length ? ', bi = -1' : '');
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

// One token at a dispatch site: the shared scanner says where it ends; the lexer records it.
function scanTok(t: LexTok, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, identLike: Set<string>): string {
  const name = t.name;
  // `emit(...)` threads the lexer state in stateful mode; a plain push otherwise. A skipped
  // token (comment) still records a newline it spans, so `sameLine` sees it.
  const kid = kidOf(ids, name);
  const push = t.skip
    ? `if (/[\\n\\r\\u2028\\u2029]/.test(src.slice(pos, e))) pendingNl = true; `
    : `${stateful ? 'emit' : 'push'}(pos, e, ${kid}, lid_of(src.slice(pos, e))); `;
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (emit-lexer.ts).
  const ext = identLike.has(name) ? 'e = lx_ext(src, e); ' : '';
  const scan = `{ let e = ${shared.scanner(name)}(src, pos); if (e >= 0) { ${ext}${push}pos = e; continue; } }`;
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
    codes.push(scanTok(t, shared, stateful, ids, rxTok, identLike));
    firsts.push(lexTokFirstBytes(t));
  }
  for (const p of ir.puncts) {
    codes.push(punctLine(p));
    firsts.push(punctFirstBytes(p));
  }
  return { codes, firsts };
}

/** Shared first-byte dispatch for all lexFrom variants in this target. */
function renderLexByteDispatchTS(codes: string[], firsts: (LexFirstBytes | null)[], indent: string): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let switchArms = '';
  for (const arm of arms) {
    switchArms += arm.bytes.map((b) => `${indent}    case ${b}:`).join('\n') + '\n';
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
function newlineParts(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; ws: string; hooks: string } {
  const flowSets = `  const _flowOpen = new Set([${nl.flowOpen.map(J).join(', ')}]);
  const _flowClose = new Set([${nl.flowClose.map(J).join(', ')}]);
`;
  return {
    state: `  let flowDepth = 0;
${flowSets}`,
    stateFrom: flowSets,
    ws: `    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) { pos++; continue; }
    if (c === 10 || c === 13) {   // LF/CR only — LS/PS fall through to the unexpected-character throw, matching the interpreter
      const s = pos;
      pos++; if (c === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
      if (flowDepth === 0) ${pushFn}(s, pos, ${kidOf(ids, nl.token)}, 0);
      pendingNl = true;
      continue;
    }
`,
    hooks: `    if (kid === 0 && _flowOpen.has(_LIDS[lid]!)) flowDepth++;
    else if (kid === 0 && _flowClose.has(_LIDS[lid]!)) flowDepth = Math.max(0, flowDepth - 1);
`,
  };
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
  const stateful = !!(rx || tpl);
  const newlineOnly = !!(nl && !rx && !tpl);
  const pushFn = stateful ? 'emit' : 'push';
  const punctLine = (p: string) =>
    `    if (src.startsWith(${J(p)}, pos)) { ${pushFn}(pos, pos + ${tlen(p)}, 0, ${lidOf(ids, p)}); pos += ${tlen(p)}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, shared, stateful, ids, rx?.regexToken, punctLine);
  const cascade = renderLexByteDispatchTS(lexCodes, lexFirsts, '    ');
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
    const isExprKw = prevKid === KID_IDENT && !!_rxT[prevLid];
    const isParenHead = prevLid === LID_RPAREN && lastClose;
    return !isExprKw && !isParenHead && (!!_divK[prevKid] || !!_divT[prevLid]);
  }
` : '';
  // The span itself is the shared family's scanner; this reads which delimiter ended it.
  const tplSpanFn = tpl ? `  function scanTplSpan(p: number, strict: boolean): { interp: boolean; end: number } {
    const q = ${shared.tplSpan()}(src, p, strict);
    if (q === -1) throw new Error('Unterminated template literal at offset ' + n);
    if (q < -1) throw new Error('Invalid escape sequence in template at offset ' + (-2 - q));
    return src.startsWith(${J(tpl.interpOpen)}, q) ? { interp: true, end: q + ${tlen(tpl.interpOpen)} } : { interp: false, end: q + ${tlen(tpl.open)} };
  }
` : '';
  const tplState = tpl ? `  const templateStack: number[] = [];
${tplSpanFn}` : '';
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
    const isExprKw = prevKid === KID_IDENT && !!_rxT[prevLid];
    const isParenHead = prevLid === LID_RPAREN && lastClose;
    return !isExprKw && !isParenHead && (!!_divK[prevKid] || !!_divT[prevLid]);
  }
` : '';
  const tplStateFrom = tplSpanFn;
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
  // Template dispatch runs at the top of the loop, before token/punct scanning.
  const tplDispatch = tpl ? `    if (templateStack.length > 0 && src.startsWith(${J(tpl.interpClose)}, pos) && templateStack[templateStack.length - 1] === 0) {
      templateStack.pop();
      const sp = scanTplSpan(pos + ${tlen(tpl.interpClose)}, false);
      if (sp.interp) { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateMiddle')}, lid_of(_tx)); templateStack.push(0); }
      else { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateTail')}, lid_of(_tx)); }
      pos = sp.end; continue;
    }
    if (src.startsWith(${J(tpl.open)}, pos)) {
      const sp = scanTplSpan(pos + ${tlen(tpl.open)}, ${rx ? '!prevIsValue()' : 'true'});
      if (sp.interp) { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateHead')}, lid_of(_tx)); templateStack.push(0); }
      else { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, tpl.token)}, lid_of(_tx)); }
      pos = sp.end; continue;
    }
` : '';
  const identNameTs = ir.identToken;
  const identKidTs = identNameTs ? kidOf(ids, identNameTs) : 0;
  const lxExtConst = ir.identLike.length
    ? `const LX_UNI_CONT = /[$\\u200c\\u200d\\p{ID_Continue}]+/uy;
function lx_ext(src: string, e: number): number {
  if (e >= src.length || src.charCodeAt(e) < 0x80) return e;
  LX_UNI_CONT.lastIndex = e;
  const m = LX_UNI_CONT.exec(src);
  return m ? e + m[0].length : e;
}
`
    : '';
  const lxUniIdentConst = (identNameTs
    ? 'const LX_UNI_IDENT = /[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*/uy;\n'
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
  const nlWs = nl ? newlineParts(nl, stateful ? 'emit' : 'push', ids).ws : `    if (c === 10 || c === 13 || c === 8232 || c === 8233) { pendingNl = true; pos++; continue; }
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) { pos++; continue; }
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
${uniIdentFallbackTs}    throw new Error('Unexpected character at offset ' + pos + ': \\'' + src[pos] + '\\'');`;
  if (rxOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, bpLid: number, hasPrev: boolean, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean } {
  const n = src.length;
  const base = toks.length;
${rxStateFrom}${emitRxOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, 0, 0, 0, false, false, [], false, false, toks);
  return toks;
}`;
  }
  if (tplOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; templateStack: number[] } {
  const n = src.length;
  const base = toks.length;
${tplStateFrom}${emitTplOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, templateStack };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, [], toks);
  return toks;
}`;
  }
  if (rxTpl) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, bpLid: number, hasPrev: boolean, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean; templateStack: number[] } {
  const n = src.length;
  const base = toks.length;
${rxStateFrom}${tplStateFrom}${emitRxTpl}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, 0, 0, 0, false, false, [], false, false, [], toks);
  return toks;
}`;
  }
  if (rxOrTpl) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${rxModuleConsts}${scans}function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let pos = 0;
  let pendingNl = false;
${rxState}${tplState}${nlState}${emitFn}  while (pos < n) {
${loopBody}
  }
  return toks;
}`;
  }
  if (newlineOnly) {
    return `${renderIdTablesTS(ids)}${lxUniIdentConst}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, flowDepth: number, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; flowDepth: number } {
  const n = src.length;
  const base = toks.length;
${nlStateFrom}${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, flowDepth };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, 0, toks);
  return toks;
}`;
  }
  return `${renderIdTablesTS(ids)}${lxUniIdentConst}${scans}function lexFrom(src: string, pos: number, pendingNl: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean } {
  const n = src.length;
  const base = toks.length;
${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, toks);
  return toks;
}`;
}

// A Step as a boolean expression (appends to the in-scope `kids`).
// When `w` is true, emit the builder-mode helpers (`matchLitW` …) that also maintain
// a parallel `spans` array — span bookkeeping never reads consumer handles.
function stepCond(s: Step, ids: LexIdPlan, w = false): string {
  const S = w ? 'W' : '';
  const ks = w ? 'kids, spans' : 'kids';
  const sc = (x: Step) => stepCond(x, ids, w);
  switch (s.t) {
    case 'lit': return `matchLit${S}(${lidOf(ids, s.value)}, ${J(s.ttype)}, ${ks})`;
    case 'tok': return `matchTok${S}(${kidOf(ids, s.name)}, ${J(s.name)}, ${ks})`;
    case 'rule': return `callRule${S}(parse${s.name}${S}, ${ks})`;
    case 'ruleBp': return `callRule${S}(() => ${s.name}_bp${S}(${s.bp}), ${ks})`;
  case 'star': return `star${S}(() => ${sc(s.step)}, ${ks})`;
  case 'opt': return `opt${S}(() => ${s.steps.map(sc).join(' && ')}, ${ks})`;
  case 'sep': return `sepBy${S}(() => ${sc(s.elem)}, ${lidOf(ids, s.delim)}, ${ks})`;
    case 'altlit': return `altLit${S}([${s.opts.map((o) => `[${lidOf(ids, o.value)}, ${J(o.ttype)}]`).join(', ')}], ${ks})`;
    case 'alt': {
      if (s.predictive) return `(() => { ${predAltBody(s.branches, ids, s.firsts, w)} })()`;
      const firsts = s.firsts ?? [];
      const nAlts = s.branches.length;
      const needPeek = s.branches.some((_, i) => isGuardable(firsts[i] ?? null, nAlts));
      const peekInit = needPeek ? `const _ft = peek(); ` : '';
      const tries = s.branches.map((br, i) => {
        const body = w
          ? `{ const sp = pos; const bk = kids.length; const bs = spans.length; if (${br.length ? br.map(sc).join(' && ') : 'true'}) return true; back(sp); kids.length = bk; spans.length = bs; }`
          : `{ const sp = pos; const bk = kids.length; if (${br.length ? br.map(sc).join(' && ') : 'true'}) return true; back(sp); kids.length = bk; }`;
        const f = firsts[i] ?? null;
        if (!isGuardable(f, nAlts)) return body;
        return `if (_ft !== null && ${firstCond(f, '_ft', ids)}) ${body}`;
      }).join(' ');
      return `(() => { ${peekInit}${tries} return false; })()`;
    }
    case 'look': return `${s.is ? '' : '!'}look${s.id}${S}(${ks})`;
    case 'ahead': return `ahead(${s.set}, ${s.is})`;
    case 'seq': return `(${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'})`;
    case 'sameLine': return `(() => { const t = peek(); return t !== null && !t.nl; })()`;
    case 'suppress': return `(() => { _suppressNext = new Set([${s.connectors.map((c) => lidOf(ids, c)).join(', ')}]); const _r = (${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'}); _suppressNext = null; return _r; })()`;
  }
}

// ParserIR.lookaheads, one function each: whether the body matches here, undoing all it did.
// It appends to the caller's children (and spans), as the step it stands for would.
function lookFns(ir: ParserIR, ids: LexIdPlan, w = false): string {
  return ir.lookaheads.map((body, id) => w
    ? `function look${id}W(kids: any[], spans: BWSpan[]): boolean { const sp = pos; const bk = kids.length; const bs = spans.length; const m = ${body.map((x) => stepCond(x, ids, true)).join(' && ')}; back(sp); kids.length = bk; spans.length = bs; return m; }\n`
    : `function look${id}(kids: Cst[]): boolean { const sp = pos; const bk = kids.length; const m = ${body.map((x) => stepCond(x, ids)).join(' && ')}; back(sp); kids.length = bk; return m; }\n`).join('');
}

function predAltBody(branches: Step[][], ids: LexIdPlan, firsts?: FirstSig[], w = false): string {
  const sc = (x: Step) => stepCond(x, ids, w);
  // FIRST dispatch still only tries the matching arm; on half-failure restore like non-pred altBody.
  const arms = branches.map((br, i) => {
    const steps = br.length ? br.map(sc).join(' && ') : 'true';
    const body = w
      ? `{ const sp = pos; const bk = kids.length; const bs = spans.length; if (${steps}) return true; back(sp); kids.length = bk; spans.length = bs; }`
      : `{ const sp = pos; const bk = kids.length; if (${steps}) return true; back(sp); kids.length = bk; }`;
    return `if (${firstCond(firsts![i], 't', ids)}) ${body}`;
  }).join(' else ');
  return `const t = peek(); if (t === null) return false; ${arms} return false;`;
}

/** Shape A: star(rule|alt(rule…)). Shape B: [opt(rule)]? star(seq(tok, opt(rule))). */
type ReusePlanA = { kind: 'A'; topOneBody: string };
type ReusePlanB = { kind: 'B'; hasHead: boolean; headRule: string | null; loopTok: string; loopRule: string };
type ReusePlan = ReusePlanA | ReusePlanB;

function matchLoopSeq(step: Step): { loopTok: string; loopRule: string } | null {
  if (step.t !== 'seq' || step.steps.length !== 2) return null;
  const [a, b] = step.steps;
  if (a.t !== 'tok') return null;
  if (b.t !== 'opt' || b.steps.length !== 1 || b.steps[0].t !== 'rule') return null;
  return { loopTok: a.name, loopRule: (b.steps[0] as { t: 'rule'; name: string }).name };
}

function topReusePlan(ir: ParserIR): ReusePlan | null {
  const entry = ir.rules.find((r) => r.name === ir.entry);
  if (!entry || entry.kind !== 'rd' || entry.alts.length !== 1) return null;
  const alt = entry.alts[0];
  // Shape A (unchanged): sole step star(rule) or star(alt(rule…))
  if (alt.length === 1 && alt[0].t === 'star') {
    const step = alt[0].step;
    if (step.t === 'rule') return { kind: 'A', topOneBody: `  return parse${step.name}();` };
    if (step.t === 'alt') {
      for (const br of step.branches) {
        if (br.length !== 1 || br[0].t !== 'rule') return null;
      }
      const tries = step.branches.map((br) => {
        const name = (br[0] as { t: 'rule'; name: string }).name;
        return `  { const sp = pos; const n = parse${name}(); if (n !== null) return n; back(sp); }`;
      }).join('\n');
      return { kind: 'A', topOneBody: `${tries}\n  return null;` };
    }
    const loop = matchLoopSeq(step);
    if (loop) return { kind: 'B', hasHead: false, headRule: null, ...loop };
    return null;
  }
  // Shape B with optional head: [opt(rule R), star(seq(tok T, opt(rule R2)))]
  if (alt.length === 2 && alt[0].t === 'opt' && alt[1].t === 'star') {
    const hs = alt[0].steps;
    if (hs.length !== 1 || hs[0].t !== 'rule') return null;
    const loop = matchLoopSeq(alt[1].step);
    if (!loop) return null;
    return { kind: 'B', hasHead: true, headRule: hs[0].name, ...loop };
  }
  return null;
}

function rdRule(r: RdRule, ids: LexIdPlan): string {
  if (r.predictive) {
  const arm = (steps: Step[], i: number) => `  ${i === 0 ? 'if' : 'else if'} (${firstCond(r.altFirst[i], 't', ids)}) { const kids: Cst[] = []; if (${steps.map((x) => stepCond(x, ids)).join(' && ')}) return branch(${J(r.cstName)}, kids, save); }`;
  return `function parse${r.name}(): Node | null {
  const save = pos;
  const t = peek(); if (t === null) return null;
${r.alts.map(arm).join(' ')}
  back(save);
  return null;
}`;
  }
  if (r.alts.length === 1) {   // nothing to choose among
    return `function parse${r.name}(): Node | null {
  const save = pos;
  { const kids: Cst[] = []; if (${r.alts[0]!.map((x) => stepCond(x, ids)).join(' && ')}) return branch(${J(r.cstName)}, kids, save); back(save); }
  return null;
}`;
  }
  // Longest match over the alternatives, reached through the rule's Dispatch (emit-portable.ts, RdRule).
  const alt = (i: number, keyed: boolean) => {
    const body = `{ const kids: Cst[] = []; if (${r.alts[i]!.map((x) => stepCond(x, ids)).join(' && ')} && ${beatsTs(r.altDispatch, 'pos', i)}) { best = branch(${J(r.cstName)}, kids, save); bestPos = pos;${markTs(r.altDispatch, i)} } back(save); }`;
    const g = guardCond(r.altGuard[i]!, '_ft', keyed);
    return ifTs(g.length && !keyed ? ['_ft !== null', ...g] : g, body);
  };
  const needPeek = r.altGuard.some((g) => g !== null);
  return `function parse${r.name}(): Node | null {
  const save = pos;
  let best: Node | null = null, bestPos = save${biTs(r.altDispatch)};
${needPeek ? '  const _ft = peek();\n' : ''}${dispatchTs(r.altDispatch, '_ft', ids, alt, true)}
  pos = bestPos;
  return best;
}`;
}

/** Builder-mode RD rule — same control flow as rdRule, returns Frame (span+handles). */
function rdRuleW(r: RdRule, ids: LexIdPlan): string {
  if (r.predictive) {
  const arm = (steps: Step[], i: number) => `  ${i === 0 ? 'if' : 'else if'} (${firstCond(r.altFirst[i], 't', ids)}) { const kids: any[] = []; const spans: BWSpan[] = []; if (${steps.map((x) => stepCond(x, ids, true)).join(' && ')}) return branchW(${J(r.cstName)}, kids, spans, save); }`;
  return `function parse${r.name}W(): Frame | null {
  const save = pos;
  const t = peek(); if (t === null) return null;
${r.alts.map(arm).join(' ')}
  back(save);
  return null;
}`;
  }
  if (r.alts.length === 1) {
    return `function parse${r.name}W(): Frame | null {
  const save = pos;
  { const kids: any[] = []; const spans: BWSpan[] = []; if (${r.alts[0]!.map((x) => stepCond(x, ids, true)).join(' && ')}) return branchW(${J(r.cstName)}, kids, spans, save); back(save); }
  return null;
}`;
  }
  const alt = (i: number, keyed: boolean) => {
    const body = `{ const kids: any[] = []; const spans: BWSpan[] = []; if (${r.alts[i]!.map((x) => stepCond(x, ids, true)).join(' && ')} && ${beatsTs(r.altDispatch, 'pos', i)}) { best = branchW(${J(r.cstName)}, kids, spans, save); bestPos = pos;${markTs(r.altDispatch, i)} } back(save); }`;
    const g = guardCond(r.altGuard[i]!, '_ft', keyed);
    return ifTs(g.length && !keyed ? ['_ft !== null', ...g] : g, body);
  };
  const needPeek = r.altGuard.some((g) => g !== null);
  return `function parse${r.name}W(): Frame | null {
  const save = pos;
  let best: Frame | null = null, bestPos = save${biTs(r.altDispatch)};
${needPeek ? '  const _ft = peek();\n' : ''}${dispatchTs(r.altDispatch, '_ft', ids, alt, true)}
  pos = bestPos;
  return best;
}`;
}

function topOneBodyW(plan: ReusePlanA): string {
  return plan.topOneBody.replace(/parse([A-Za-z0-9_]+)\(\)/g, 'parse$1W()');
}

function rdEntryWithReuseW(r: RdRule, plan: ReusePlan, ids: LexIdPlan): string {
  if (plan.kind === 'A') {
    return `function parseTopOneW(): Frame | null {
${topOneBodyW(plan)}
}
function parse${r.name}W(): Frame | null {
  const save = pos;
  const kids: any[] = [];
  const spans: BWSpan[] = [];
  // Engine-side EntryMeta (R2): never mutate consumer handles.
  const localE: EntryMeta[] = [];
  for (;;) {
    const sp = pos;
    lookReset();
    const n = parseTopOneW();
    if (n === null) { back(sp); break; }
    const ext = Math.max(n.tokEnd, lookEnd());
    localE.push({ tokStart: n.tokStart, tokEnd: n.tokEnd, ext, off: n.off, end: n.end, kidStart: spans.length, kidCount: 1 });
    absorbFrame(kids, spans, n);
  }
  _entries = localE;
  _entryHs = kids.slice();
  return branchW(${J(r.cstName)}, kids, spans, save);
}`;
  }
  const headBlock = plan.hasHead && plan.headRule
    ? `  {
    const pair = parseHeadSegW(kids, spans);
    if (pair) { segs.push(pair.seg); localE.push(pair.meta); }
  }
`
    : '';
  const headFn = plan.hasHead && plan.headRule
    ? `function parseHeadSegW(kids: any[], spans: BWSpan[]): { seg: Seg; meta: EntryMeta } | null {
  lookReset();
  const kidStart = kids.length;
  const before = kids.length;
  const spanBefore = spans.length;
  optW(() => callRuleW(parse${plan.headRule}W, kids, spans), kids, spans);
  if (kids.length === before) return null;
  const sp0 = spans[spanBefore]!;
  const sp1 = spans[spans.length - 1]!;
  const tokStart = sp0.tokStart;
  const tokEnd = sp1.tokEnd;
  const ext = Math.max(sp1.tokEnd, lookEnd());
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: sp0.off, end: sp1.end, kidStart, kidCount: 1 };
  return { seg: { kidStart, kidCount: 1, tokStart, tokEnd, ext }, meta };
}
`
    : '';
  return `${headFn}function parseLoopSegW(kids: any[], spans: BWSpan[]): { seg: Seg; meta: EntryMeta } | null {
  const sp = pos;
  const kidStart = kids.length;
  const spanStart = spans.length;
  lookReset();
  if (!matchTokW(${kidOf(ids, plan.loopTok)}, ${J(plan.loopTok)}, kids, spans)) { back(sp); kids.length = kidStart; spans.length = spanStart; return null; }
  optW(() => callRuleW(parse${plan.loopRule}W, kids, spans), kids, spans);
  const leafSp = spans[spanStart]!;
  const hasStmt = spans.length > spanStart + 1;
  const rawEnd = hasStmt ? spans[spanStart + 1]!.tokEnd : leafSp.tokEnd;
  const tokEnd = rawEnd;
  const tokStart = leafSp.tokStart;
  const end = hasStmt ? spans[spanStart + 1]!.end : leafSp.end;
  const ext = Math.max(rawEnd, lookEnd());
  const kidCount = kids.length - kidStart;
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: leafSp.off, end, kidStart, kidCount };
  return { seg: { kidStart, kidCount, tokStart, tokEnd, ext }, meta };
}
function parse${r.name}W(): Frame | null {
  const save = pos;
  const kids: any[] = [];
  const spans: BWSpan[] = [];
  const segs: Seg[] = [];
  const localE: EntryMeta[] = [];
${headBlock}  for (;;) {
    const pair = parseLoopSegW(kids, spans);
    if (pair === null) break;
    segs.push(pair.seg);
    localE.push(pair.meta);
  }
  _segs = segs;
  _entries = localE;
  _entryHs = kids.slice();
  return branchW(${J(r.cstName)}, kids, spans, save);
}`;
}

/** Entry rule that records per-top-kid EntryMeta via parseTopOne (shape A). */
function rdEntryWithReuseA(r: RdRule, plan: ReusePlanA, _ids: LexIdPlan): string {
  return `type EntryMeta = { tokStart: number; tokEnd: number; ext: number; off: number; end: number; kidStart: number; kidCount: number };
let _entries: EntryMeta[] = [];
let _entryHs: any[] = [];
function parseTopOne(): Node | null {
${plan.topOneBody}
}
function parse${r.name}(): Node | null {
  const save = pos;
  const kids: Cst[] = [];
  const localE: EntryMeta[] = [];
  for (;;) {
    const sp = pos;
    lookReset();
    const n = parseTopOne();
    if (n === null) { back(sp); break; }
    localE.push({ tokStart: sp, tokEnd: pos, ext: Math.max(pos, lookEnd()), off: n.offset, end: n.end, kidStart: kids.length, kidCount: 1 });
    kids.push(n);
  }
  _entries = localE;
  _entryHs = kids;
  return branch(${J(r.cstName)}, kids, save);
}`;
}

/** Entry rule that builds a segment table for newline-interleaved kids (shape B). */
function rdEntryWithReuseB(r: RdRule, plan: ReusePlanB, ids: LexIdPlan): string {
  const headBlock = plan.hasHead && plan.headRule
    ? `  {
    const pair = parseHeadSeg(kids);
    if (pair) { segs.push(pair.seg); localE.push(pair.meta); }
  }
`
    : '';
  const headFn = plan.hasHead && plan.headRule
    ? `function parseHeadSeg(kids: Cst[]): { seg: Seg; meta: EntryMeta } | null {
  lookReset();
  const sp = pos;
  const kidStart = kids.length;
  const before = kids.length;
  opt(() => callRule(parse${plan.headRule}, kids), kids);
  if (kids.length === before) return null;
  const n = kids[before] as Node;
  const ext = Math.max(pos, lookEnd());
  const tokStart = sp, tokEnd = pos;
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: n.offset, end: n.end, kidStart, kidCount: 1 };
  return { seg: { kidStart, kidCount: 1, tokStart, tokEnd, ext }, meta };
}
`
    : '';
  return `type Seg = { kidStart: number; kidCount: number; tokStart: number; tokEnd: number; ext: number };
type EntryMeta = { tokStart: number; tokEnd: number; ext: number; off: number; end: number; kidStart: number; kidCount: number };
let _segs: Seg[] = [];
let _entries: EntryMeta[] = [];
let _entryHs: any[] = [];
${headFn}function parseLoopSeg(kids: Cst[]): { seg: Seg; meta: EntryMeta } | null {
  const sp = pos;
  const kidStart = kids.length;
  lookReset();
  if (!matchTok(${kidOf(ids, plan.loopTok)}, ${J(plan.loopTok)}, kids)) { back(sp); kids.length = kidStart; return null; }
  opt(() => callRule(parse${plan.loopRule}, kids), kids);
  const leaf = kids[kidStart]!;
  const hasStmt = kids.length > kidStart + 1;
  const end = hasStmt ? kids[kidStart + 1]!.end : leaf.end;
  const ext = Math.max(pos, lookEnd());
  const tokStart = sp, tokEnd = pos;
  const kidCount = kids.length - kidStart;
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: leaf.offset, end, kidStart, kidCount };
  return { seg: { kidStart, kidCount, tokStart, tokEnd, ext }, meta };
}
function parse${r.name}(): Node | null {
  const save = pos;
  const kids: Cst[] = [];
  const segs: Seg[] = [];
  const localE: EntryMeta[] = [];
${headBlock}  for (;;) {
    const pair = parseLoopSeg(kids);
    if (pair === null) break;
    segs.push(pair.seg);
    localE.push(pair.meta);
  }
  _segs = segs;
  _entries = localE;
  _entryHs = kids;
  return branch(${J(r.cstName)}, kids, save);
}`;
}

function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan): string {
  return plan.kind === 'A' ? rdEntryWithReuseA(r, plan, ids) : rdEntryWithReuseB(r, plan, ids);
}

function prattRule(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan): string {
  // The NUD arms, each a longest-match candidate tried from `save`, reached through the rule's
  // Dispatch (emit-portable.ts, PrattRule.nudOrder / nudDispatch): `won(...)` records the arm as the best so far.
  const won = (i: number, nodeExpr: string, form: string, tail: boolean, capped: boolean) =>
    `best = ${nodeExpr}; bestPos = pos;${markTs(r.nudDispatch, i)} bf = ${form}; bt = ${tail}; bc = ${capped};`;
  const stepsCond = (steps: Step[]) => (steps.length ? steps.map((x) => stepCond(x, ids)).join(' && ') : 'true');
  const seqArm = (i: number, steps: Step[], tail: boolean, capped: boolean) =>
    `{ const kids: Cst[] = []; if (${stepsCond(steps)} && ${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `branch(${J(r.cstName)}, kids, save)`, '0', tail, capped)} } back(save); }`;
  const nudArm = (i: number, keyed: boolean): string => {
    const a = r.nudOrder[i]!;
    switch (a.kind) {
      case 'tok': {
        const k = r.nudToks[a.index]!;
        const leafArm = ifTs(keyed ? [] : [`t.kid === ${kidOf(ids, k)}`], `{ pos++; if (${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `{ rule: ${J(r.cstName)}, children: [{ tokenType: tok_kind(t), offset: t.off, end: t.end }], offset: t.off, end: t.end }`, '0', false, false)} } back(save); }`);
        if (r.nudTplHole === undefined || !tpl || k !== tpl.token) return leafArm;
        return `${leafArm}
  if (t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplate(parse${r.nudTplHole}); if (node !== null && ${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `{ rule: ${J(r.cstName)}, children: [node], offset: node.offset, end: node.end }`, '0', false, false)} } back(save); }`;
      }
      case 'bracket': {
        const b = r.nudBrackets[a.index]!;
        return ifTs(keyed ? [] : [`t.lid === ${lidOf(ids, b.first)}`], seqArm(i, b.steps, r.nudBracketClosesTail[a.index]!, false));
      }
      case 'seq':
        return ifTs(guardCond(r.nudSeqGuard[a.index]!, 't', keyed), seqArm(i, r.nudSeqs[a.index]!, r.nudSeqClosesTail[a.index]!, false));
      case 'capped': {
        const c = r.nudCapped[a.index]!;
        return ifTs([`minBp < ${c.capBp}`, ...guardCond(r.nudCappedGuard[a.index]!, 't', keyed)], seqArm(i, c.steps, false, true));
      }
      case 'prefix':
        // An operand that parses but is not the target the operator requires fails the whole
        // Pratt call, whatever another arm matched.
        return `  { const pbp = ${r.name}_PRE[t.lid];
    if (pbp !== undefined) {
      pos++;
      const operand = ${r.name}_bp(pbp);
      if (operand !== null) {
        if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { back(save); _capped = false; return null; }
        if (${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `{ rule: ${J(r.cstName)}, children: [{ tokenType: '$operator', offset: t.off, end: t.end }, operand], offset: t.off, end: operand.end }`, `${r.name}_PRE_FORM[t.lid]!`, true, false)} }
      }
      back(save);
    } }`;
    }
  };
  const BIN = `{ ${r.binary.map((b) => `${lidOf(ids, b.op)}: { lbp: ${b.lbp}, rbp: ${b.rbp}, tgt: ${b.requireTarget}, noUnary: ${b.noUnaryLhs} }`).join(', ')} }`;
  const PRE = `{ ${r.prefix.map((p) => `${lidOf(ids, p.op)}: ${p.rbp}`).join(', ')} }`;
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.nl');
    if (nll) parts.push(`!${J(nll)}.includes(headLeafText(left))`);
    parts.push(`(_suppressCur === null || !_suppressCur.has(${lid}))`);
    return parts.join(' && ');
  };
  // A lid that ALSO has a binary entry (`<` is both a type-arg LED and the
  // relational operator) must not `break` the Pratt loop when its LED arms
  // fail — the restore happens, then control falls through to the binary
  // check below so `<` still parses as a comparison. Multiple arms sharing a
  // lid (e.g. `[` array-type then indexed-access) fall through to each other;
  // only the LAST arm of a group emits `break ledLoop`.
  const binLids = new Set(r.binary.map((b) => lidOf(ids, b.op)));
  const ledBody = (b: Bracket, form: number, closes: boolean, hasBin: boolean, isLast: boolean) => `{
      const ledSave = pos; const kids: Cst[] = [left];
      if (${b.steps.map((x) => stepCond(x, ids)).join(' && ')}) { left = node(${J(r.cstName)}, kids); form = ${form};${closes ? ' tailClosed = true;' : ''} continue ledLoop; }
      back(ledSave);${hasBin ? '' : isLast ? ' break ledLoop;' : ''}
    }`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `    switch (t.lid) {
${groups.map((g) => {
  const lid = g.key as number;
  const hasBin = binLids.has(lid);
  const arms = g.members.map(({ item: b, index: i }, j) =>
    `      if (${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)}) ${ledBody(b, r.ledForm[i]!, r.ledClosesTail[i]!, hasBin, j === g.members.length - 1)}`);
  return `      case ${lid}:\n${arms.join('\n')}\n        break;`;
}).join('\n')}
    }`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const tplPart = r.postfixTplHole !== undefined ? `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplate(parse${r.postfixTplHole}); if (node !== null) { left = { rule: ${J(r.cstName)}, children: [left, node], offset: left.offset, end: node.end }; form = 0; continue ledLoop; } }` : '';
    return `    switch (t.kid) {
${groups.map((g) => `      case ${g.key}:
        if (!tailClosed) { const leaf: Leaf = { tokenType: tok_kind(t), offset: t.off, end: t.end }; pos++; left = { rule: ${J(r.cstName)}, children: [left, leaf], offset: left.offset, end: leaf.end }; form = 0; continue ledLoop; }
        break;`).join('\n')}
    }${tplPart}`;
  })();
  const POST = `{ ${r.postfix.map((p) => `${lidOf(ids, p.op)}: ${p.lbp}`).join(', ')} }`;
  return `const ${r.name}_BIN: Record<number, { lbp: number; rbp: number; tgt: boolean; noUnary: boolean }> = ${BIN};
const ${r.name}_PRE: Record<number, number> = ${PRE};
const ${r.name}_PRE_FORM: Record<number, number> = { ${r.prefix.map((p) => `${lidOf(ids, p.op)}: ${p.form}`).join(', ')} };
const ${r.name}_PRE_TGT = new Set<number>([${r.prefix.filter((p) => p.requireTarget).map((p) => lidOf(ids, p.op)).join(', ')}]);
const ${r.name}_POST: Record<number, number> = ${POST};
const ${r.name}_POST_TGT = new Set<number>([${r.postfix.filter((p) => p.requireTarget).map((p) => lidOf(ids, p.op)).join(', ')}]);
function parse${r.name}(): Node | null {
  const prev = _suppressCur; _suppressCur = _suppressNext; _suppressNext = null;
  const r = ${r.name}_bp(0);
  _suppressCur = prev;
  return r;
}
function ${r.name}_bp(minBp: number): Node | null {
  let left = ${r.name}_nud(minBp);
  if (left === null) return null;
  let form = _form;
  if (_capped) return left;   // an assignment-level arrow admits no led
  let tailClosed = _tail;
  ${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;
${ledSwitch}
${postfixTokSwitch}
    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) return null;
      const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end }; pos++; left = { rule: ${J(r.cstName)}, children: [left, opLeaf], offset: left.offset, end: t.end }; tailClosed = true; form = 1; continue;
    }
    const info = ${r.name}_BIN[_opLid(t)];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) return null;
    const ledSave = pos;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: _opEnd };
    pos += _opN;
    const rhs = ${r.name}_bp(info.rbp);
    if (rhs === null) { back(ledSave); break; }
    left = { rule: ${J(r.cstName)}, children: [left, opLeaf, rhs], offset: left.offset, end: rhs.end };
    form = 1; tailClosed = true;
  }
  _form = form;
  return left;
}
function ${r.name}_nud(minBp: number): Node | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
  const save = pos;
  let best: Node | null = null, bestPos = save${biTs(r.nudDispatch)}, bf = 0, bt = false, bc = false;
${dispatchTs(r.nudDispatch, 't', ids, nudArm)}
  // A sub-parse may leave _capped set (e.g. grouping a capped arrow): only a capped arm that
  // won makes THIS node capped.
  _capped = bc;
  _form = bf;
  _tail = bt;
  pos = bestPos;
  return best;
}`;
}

/** Builder-mode Pratt — reuses ${name}_BIN/_PRE/_POST/_ATOM tables from the CST emit. */
function prattRuleW(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan): string {
  const cn = J(r.cstName);
  // The NUD arms: longest-match candidates through the rule's Dispatch, as in prattRule.
  const won = (i: number, frameExpr: string, form: string, tail: boolean, capped: boolean) =>
    `best = ${frameExpr}; bestPos = pos;${markTs(r.nudDispatch, i)} bf = ${form}; bt = ${tail}; bc = ${capped};`;
  const stepsCond = (steps: Step[]) => (steps.length ? steps.map((x) => stepCond(x, ids, true)).join(' && ') : 'true');
  const seqArm = (i: number, steps: Step[], tail: boolean, capped: boolean) =>
    `{ const kids: any[] = []; const spans: BWSpan[] = []; if (${stepsCond(steps)} && ${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `branchW(${cn}, kids, spans, save)`, '0', tail, capped)} } back(save); }`;
  const nudArm = (i: number, keyed: boolean): string => {
    const a = r.nudOrder[i]!;
    switch (a.kind) {
      case 'tok': {
        const k = r.nudToks[a.index]!;
        const leafArm = ifTs([...(keyed ? [] : [`t.kid === ${kidOf(ids, k)}`]), beatsTs(r.nudDispatch, 'save + 1', i)], `{ const lf = leafFrameW(tok_kind(t), t); pos++; ${won(i, `wrapUnaryW(${cn}, lf)`, '0', false, false)} back(save); }`);
        if (r.nudTplHole === undefined || !tpl || k !== tpl.token) return leafArm;
        return `${leafArm}
  if (t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplateW(parse${r.nudTplHole}W); if (node !== null && ${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `wrapUnaryW(${cn}, node)`, '0', false, false)} } back(save); }`;
      }
      case 'bracket': {
        const b = r.nudBrackets[a.index]!;
        return ifTs(keyed ? [] : [`t.lid === ${lidOf(ids, b.first)}`], seqArm(i, b.steps, r.nudBracketClosesTail[a.index]!, false));
      }
      case 'seq':
        return ifTs(guardCond(r.nudSeqGuard[a.index]!, 't', keyed), seqArm(i, r.nudSeqs[a.index]!, r.nudSeqClosesTail[a.index]!, false));
      case 'capped': {
        const c = r.nudCapped[a.index]!;
        return ifTs([`minBp < ${c.capBp}`, ...guardCond(r.nudCappedGuard[a.index]!, 't', keyed)], seqArm(i, c.steps, false, true));
      }
      case 'prefix':
        return `  { const pbp = ${r.name}_PRE[t.lid];
    if (pbp !== undefined) {
      const lf = leafFrameW('$operator', t);
      pos++;
      const operand = ${r.name}_bpW(pbp);
      if (operand !== null) {
        if (_form !== 0 && ${r.name}_PRE_TGT.has(t.lid)) { back(save); _capped = false; return null; }
        if (${beatsTs(r.nudDispatch, 'pos', i)}) { ${won(i, `joinFramesW(${cn}, lf, operand)`, `${r.name}_PRE_FORM[t.lid]!`, true, false)} }
      }
      back(save);
    } }`;
    }
  };
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.nl');
    if (nll) parts.push(`!${J(nll)}.includes(headLeafTextW(left))`);
    parts.push(`(_suppressCur === null || !_suppressCur.has(${lid}))`);
    return parts.join(' && ');
  };
  // See prattRule: a lid that is BOTH a LED first-token and a binary op must
  // fall through to the binary check on LED failure instead of breaking.
  // Multiple arms sharing a lid fall through to each other; only the LAST arm
  // of a group emits `break ledLoop`.
  const binLids = new Set(r.binary.map((b) => lidOf(ids, b.op)));
  const ledBody = (b: Bracket, form: number, closes: boolean, hasBin: boolean, isLast: boolean) => `{
      const ledSave = pos; const kids: any[] = []; const spans: BWSpan[] = [];
      absorbFrame(kids, spans, left);
      if (${b.steps.map((x) => stepCond(x, ids, true)).join(' && ')}) { left = nodeW(${cn}, kids, spans); form = ${form};${closes ? ' tailClosed = true;' : ''} continue ledLoop; }
      back(ledSave);${hasBin ? '' : isLast ? ' break ledLoop;' : ''}
    }`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `    switch (t.lid) {
${groups.map((g) => {
  const lid = g.key as number;
  const hasBin = binLids.has(lid);
  const arms = g.members.map(({ item: b, index: i }, j) =>
    `      if (${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)}) ${ledBody(b, r.ledForm[i]!, r.ledClosesTail[i]!, hasBin, j === g.members.length - 1)}`);
  return `      case ${lid}:\n${arms.join('\n')}\n        break;`;
}).join('\n')}
    }`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const tplPart = r.postfixTplHole !== undefined ? `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplateW(parse${r.postfixTplHole}W); if (node !== null) { left = joinFramesW(${cn}, left, node); form = 0; continue ledLoop; } }` : '';
    return `    switch (t.kid) {
${groups.map((g) => `      case ${g.key}:
        if (!tailClosed) { const lf = leafFrameW(tok_kind(t), t); pos++; left = joinFramesW(${cn}, left, lf); form = 0; continue ledLoop; }
        break;`).join('\n')}
    }${tplPart}`;
  })();
  return `function parse${r.name}W(): Frame | null {
  const prev = _suppressCur; _suppressCur = _suppressNext; _suppressNext = null;
  const r = ${r.name}_bpW(0);
  _suppressCur = prev;
  return r;
}
function ${r.name}_bpW(minBp: number): Frame | null {
  let left = ${r.name}_nudW(minBp);
  if (left === null) return null;
  let form = _form;
  if (_capped) return left;   // an assignment-level arrow admits no led
  let tailClosed = _tail;
  ${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;
${ledSwitch}
${postfixTokSwitch}
    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp${r.postfixSameLine ? ' && !t.nl' : ''}) {
      if (form !== 0 && ${r.name}_POST_TGT.has(t.lid)) return null;
      const lf = leafFrameW('$operator', t); pos++; left = joinFramesW(${cn}, left, lf); tailClosed = true; form = 1; continue;
    }
    const opLid = _opLid(t);
    const info = ${r.name}_BIN[opLid];
    if (info === undefined || info.lbp <= minBp) break;
    if (info.tgt && form !== 0 || info.noUnary && form === 2) return null;
    const ledSave = pos;
    const lf = opFrameW(t, opLid);
    pos += _opN;
    const rhs = ${r.name}_bpW(info.rbp);
    if (rhs === null) { back(ledSave); break; }
    left = joinFramesW(${cn}, left, lf, rhs);
    form = 1; tailClosed = true;
  }
  _form = form;
  return left;
}
function ${r.name}_nudW(minBp: number): Frame | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
  const save = pos;
  let best: Frame | null = null, bestPos = save${biTs(r.nudDispatch)}, bf = 0, bt = false, bc = false;
${dispatchTs(r.nudDispatch, 't', ids, nudArm)}
  _capped = bc;
  _form = bf;
  _tail = bt;
  pos = bestPos;
  return best;
}`;
}

type DocEditParts = {
  editBody: string;
  initToks: string;
  freshMeta: string;
  shapeA: boolean;
  shapeB: boolean;
  hasHeadB: boolean;
  topReuse: boolean;
  entryCst: string;
};

/** Additive parseWith / Builder / cstBuilder — appended after the unchanged CST library. */
function emitBuilderAddon(ir: ParserIR, ids: LexIdPlan, doc: DocEditParts): string {
  const reuse = topReusePlan(ir);
  const shapeA = doc.shapeA;
  const shapeB = doc.shapeB;
  const hasHeadB = doc.hasHeadB;
  const entryCst = doc.entryCst;
  const ruleFnsW = ir.rules.map((r) => {
    if (r.kind === 'pratt') return prattRuleW(r, ir.tpl, ids);
    if (reuse && r.name === ir.entry) return rdEntryWithReuseW(r, reuse, ids);
    return rdRuleW(r, ids);
  }).join('\n\n');
  const matchTemplateW = ir.tpl ? `// interp: the rule that parses each \`\${…}\` hole — the one the matching reference declares.
function matchTemplateW(interp: () => Frame | null): Frame | null {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return null;
  const kids: any[] = []; const spans: BWSpan[] = [];
  const save = pos;
  {
    const lf = leafFrameW('$templateHead', t); pos++;
    absorbFrame(kids, spans, lf);
  }
  for (;;) {
    const expr = interp();
    if (expr === null) { back(save); return null; }
    absorbFrame(kids, spans, expr);
    const next = peek();
    if (next === null) { back(save); return null; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) { const lf = leafFrameW('$templateMiddle', next); pos++; absorbFrame(kids, spans, lf); continue; }
    if (next.kid === ${kidOf(ids, '$templateTail')}) { const lf = leafFrameW('$templateTail', next); pos++; absorbFrame(kids, spans, lf); break; }
    back(save); return null;
  }
  return finishNodeW('$template', kids, spans, save);
}
` : '';
  return `// ─── Builder API (additive; CST parse() above is unchanged) ─────────────────
// Builder must be pure / bottom-up. Backtracking simply abandons Frame values —
// there is no rollback callback; discarded handles become garbage.
// Optional shift: method presence (builder.shift == null → Doc.edit fresh parseWith).
// treeEq on validate: only when builder === cstBuilder (rust SUPPORTS_TREE_EQ analogue).
export type Builder<H> = {
  leaf(tokenType: string, kid: number, lid: number, off: number, end: number): H | null;
  node(rule: string, children: H[], off: number, end: number): H | H[] | null;
  /** Optional incremental shift. Missing → Doc.edit degenerates to fresh parseWith. */
  shift?(h: H, byteDelta: number, tokDelta: number): H;
};
type BWSpan = { off: number; end: number; tokStart: number; tokEnd: number; headOff: number; headEnd: number };
type Frame = { hs: any[]; off: number; end: number; tokStart: number; tokEnd: number; headOff: number; headEnd: number };
let _builder: Builder<any> = null!;
let _bSave = 0;
function packNodeW(r: any, off: number, end: number, tokStart: number, tokEnd: number, headOff: number, headEnd: number): Frame {
  if (r === null) return { hs: [], off, end, tokStart, tokEnd, headOff, headEnd };
  if (Array.isArray(r)) return { hs: r, off, end, tokStart, tokEnd, headOff, headEnd };
  return { hs: [r], off, end, tokStart, tokEnd, headOff, headEnd };
}
function absorbFrame(kids: any[], spans: BWSpan[], f: Frame): void {
  for (let i = 0; i < f.hs.length; i++) kids.push(f.hs[i]);
  // Span is recorded whenever the child Frame covers a region. Empty hs (node-null drop)
  // still contributes span so parent off/end cover the production; leaf-null never creates a Frame.
  spans.push({ off: f.off, end: f.end, tokStart: f.tokStart, tokEnd: f.tokEnd, headOff: f.headOff, headEnd: f.headEnd });
}
function leafFrameW(ttype: string, t: Tok): Frame {
  const h = _builder.leaf(ttype, t.kid, t.lid, t.off, t.end);
  return { hs: h === null ? [] : [h], off: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1, headOff: t.off, headEnd: t.end };
}
// A binary operator leaf: the composite _opLid just read (lid, _opN tokens, ending at _opEnd).
function opFrameW(t: Tok, lid: number): Frame {
  const h = _builder.leaf('$operator', t.kid, lid, t.off, _opEnd);
  return { hs: h === null ? [] : [h], off: t.off, end: _opEnd, tokStart: pos, tokEnd: pos + _opN, headOff: t.off, headEnd: _opEnd };
}
function finishNodeW(rule: string, kids: any[], spans: BWSpan[], save: number): Frame {
  const off = spans.length > 0 ? spans[0]!.off : (save < toks.length ? toks[save]!.off : 0);
  const end = spans.length > 0 ? spans[spans.length - 1]!.end : off;
  const tokStart = save;
  const tokEnd = pos;
  const headOff = spans.length > 0 ? spans[0]!.headOff : off;
  const headEnd = spans.length > 0 ? spans[0]!.headEnd : end;
  _bSave = tokStart;
  return packNodeW(_builder.node(rule, kids, off, end), off, end, tokStart, tokEnd, headOff, headEnd);
}
function branchW(rule: string, kids: any[], spans: BWSpan[], save: number): Frame {
  return finishNodeW(rule, kids, spans, save);
}
function nodeW(rule: string, kids: any[], spans: BWSpan[], fallbackOff: number = 0): Frame {
  const off = spans.length ? spans[0]!.off : fallbackOff;
  const end = spans.length ? spans[spans.length - 1]!.end : fallbackOff;
  const tokStart = spans.length ? spans[0]!.tokStart : pos;
  const tokEnd = pos;
  const headOff = spans.length ? spans[0]!.headOff : off;
  const headEnd = spans.length ? spans[0]!.headEnd : end;
  _bSave = tokStart;
  return packNodeW(_builder.node(rule, kids, off, end), off, end, tokStart, tokEnd, headOff, headEnd);
}
function joinFramesW(rule: string, ...frames: Frame[]): Frame {
  const kids: any[] = []; const spans: BWSpan[] = [];
  for (const f of frames) absorbFrame(kids, spans, f);
  return nodeW(rule, kids, spans);
}
function wrapUnaryW(rule: string, child: Frame): Frame {
  return joinFramesW(rule, child);
}
function headLeafTextW(f: Frame): string { return _src.slice(f.headOff, f.headEnd); }
function matchLitW(lid: number, ttype: string, kids: any[], spans: BWSpan[]): boolean {
  if (_GT_LIT[lid] !== 0) return _matchComp(lid);
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  const f = leafFrameW(ttype, t); pos++;
  // Mirror CST matchLit: $punct is never a child. Other leaf-null drops also skip the span slot
  // so parent off/end track surviving children (matches CST omitting $punct).
  if (f.hs.length > 0) absorbFrame(kids, spans, f);
  else if (ttype !== '$punct') { /* intentional drop — no span */ }
  return true;
}
function matchTokW(kid: number, name: string, kids: any[], spans: BWSpan[]): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  const f = leafFrameW(name, t); pos++;
  if (f.hs.length > 0) absorbFrame(kids, spans, f);
  return true;
}
function callRuleW(fn: () => Frame | null, kids: any[], spans: BWSpan[]): boolean {
  const n = fn();
  if (n === null) return false;
  absorbFrame(kids, spans, n); return true;
}
function starW(once: () => boolean, kids: any[], spans: BWSpan[]): boolean {
  for (;;) { const sp = pos; const before = kids.length; const bs = spans.length; if (!once()) { back(sp); kids.length = before; spans.length = bs; break; } }
  return true;
}
function optW(body: () => boolean, kids: any[], spans: BWSpan[]): boolean {
  const sp = pos; const before = kids.length; const bs = spans.length; if (!body()) { back(sp); kids.length = before; spans.length = bs; } return true;
}
function sepByW(elem: () => boolean, delimLid: number, kids: any[], spans: BWSpan[]): boolean {
  // Match interpreter matchSep: restore on elem failure (zero elems OK; trailing delim keeps delim).
  const sp0 = pos; const before0 = kids.length; const bs0 = spans.length;
  if (!elem()) { back(sp0); kids.length = before0; spans.length = bs0; return true; }
  for (;;) {
    const sp = pos; const before = kids.length; const bs = spans.length;
    if (!matchLitW(delimLid, '$punct', kids, spans)) { back(sp); kids.length = before; spans.length = bs; break; }
    const sp2 = pos; const before2 = kids.length; const bs2 = spans.length;
    if (!elem()) { back(sp2); kids.length = before2; spans.length = bs2; break; }
  }
  return true;
}
function altLitW(opts: [number, string][], kids: any[], spans: BWSpan[]): boolean {
  for (const [lid, tt] of opts) if (matchLitW(lid, tt, kids, spans)) return true;
  return false;
}
${matchTemplateW}${lookFns(ir, ids, true)}${ruleFnsW}

/** Default CST builder — same object shape as parse(). */
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

/**
 * parseWith: second instantiation of the same grammar logic driven by \`builder\`.
 * Handles are opaque — the parser never reads offset/end/tok* from H.
 * Builder must be pure; backtracking discards Frames without notifying the builder.
 */
export function parseWith<H>(src: string, builder: Builder<H>): H | null {
  _src = src;
  toks = lex(src);
  pos = 0;
  lookReset();
  _builder = builder;
  const root = parse${ir.entry}W();
  if (root === null || pos !== toks.length) return null;
  if (root.hs.length === 0) return null;
  if (root.hs.length === 1) return root.hs[0] as H;
  // Root spliced into multiple handles — not representable as single H; reject.
  return null;
}

/** Parse with builder over AlignMeta-backed toks (Doc.edit path; avoids relex). */
function parseWithMeta<H>(text: string, meta: AlignMeta[], builder: Builder<H>): { root: H | null; entries: any[]; entryHs: any[]; segs: any[] } {
  _src = text;
  toks = toksFromMeta(text, meta);
  pos = 0;
  lookReset();
  _builder = builder;
  const fr = parse${ir.entry}W();
  if (fr === null || pos !== toks.length || fr.hs.length !== 1) {
    return { root: null, entries: [], entryHs: [], segs: [] };
  }
  return {
    root: fr.hs[0] as H,
    entries: ${doc.topReuse ? '_entries.slice()' : '[] as any[]'},
    entryHs: ${doc.topReuse ? '_entryHs.slice()' : '[] as any[]'},
    segs: ${shapeB ? '_segs.slice()' : '[] as any[]'},
  };
}
${shapeA ? `
function tryReuseTopW<H>(builder: Builder<H>, shift: (h: H, bd: number, td: number) => H, oldHs: H[], oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null {
  let prefixLen = 0;
  while (prefixLen < oldEntries.length) {
    if (oldEntries[prefixLen]!.ext <= prefix) prefixLen++;
    else break;
  }
  let suffixStart = oldEntries.length;
  for (let i = oldEntries.length - 1; i >= prefixLen; i--) {
    if (oldEntries[i]!.tokStart >= oldN - suffix) suffixStart = i;
    else break;
  }
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
  const suffixBound = newN - suffix;
  const maxCand = suffixMeta.length > 0 ? Math.max(...suffixMeta.map((m) => m.tokStart + tokDelta)) : -1;
  const finish = (adoptFrom: number): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const adopted = suffixCand.slice(adoptFrom).map((h) => shift(h, byteDelta, tokDelta));
    const children: H[] = [...prefixKids, ...mid, ...adopted];
    const adoptedMeta = suffixMeta.slice(adoptFrom);
    const newEntries: EntryMeta[] = new Array(prefixMeta.length + midMeta.length + adoptedMeta.length);
    let ei = 0;
    for (let i = 0; i < prefixMeta.length; i++) newEntries[ei++] = prefixMeta[i]!;
    for (let i = 0; i < midMeta.length; i++) newEntries[ei++] = midMeta[i]!;
    for (let i = 0; i < adoptedMeta.length; i++) {
      const m = { ...adoptedMeta[i]! };
      shiftEntryMeta(m, byteDelta, tokDelta);
      newEntries[ei++] = m;
    }
    const offset = newEntries.length > 0 ? newEntries[0]!.off : 0;
    const end = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.end : offset;
    const tokStart = newEntries.length > 0 ? newEntries[0]!.tokStart : 0;
    const tokEnd = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.tokEnd : 0;
    _bSave = tokStart;
    const savePos = pos;
    pos = tokEnd;
    const r = builder.node(${J(entryCst)}, children, offset, end);
    pos = savePos;
    if (r === null || Array.isArray(r)) return null;
    return { root: r as H, entries: newEntries, entryHs: children, reused: prefixKids.length + adopted.length };
  };
  const tryHit = (): { root: H; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    if (pos < suffixBound) return null;
    if (suffixCand.length === 0) {
      if (pos === newN) return finish(0);
      return null;
    }
    const hit = suffixMeta.findIndex((m) => m.tokStart + tokDelta === pos);
    if (hit >= 0) return finish(hit);
    return null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
  for (;;) {
    if (pos >= toks.length) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit();
    }
    lookReset();
    const sp = pos;
    const fr = parseTopOneW();
    if (fr === null || fr.hs.length !== 1) { back(sp); return null; }
    const ext = Math.max(fr.tokEnd, lookEnd());
    midMeta.push({ tokStart: fr.tokStart, tokEnd: fr.tokEnd, ext, off: fr.off, end: fr.end, kidStart: 0, kidCount: 1 });
    mid.push(fr.hs[0] as H);
    const hit = tryHit();
    if (hit) return hit;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
}
` : ''}${shapeB ? `
function tryReuseSegW<H>(builder: Builder<H>, shift: (h: H, bd: number, td: number) => H, oldRootHs: H[], oldSegs: Seg[], oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null {
  if (oldSegs.length === 0) return null;
  let prefixLen = 0;
  while (prefixLen < oldEntries.length) {
    if (oldEntries[prefixLen]!.ext <= prefix) prefixLen++;
    else break;
  }
  let suffixStart = oldEntries.length;
  for (let i = oldEntries.length - 1; i >= prefixLen; i--) {
    if (oldEntries[i]!.tokStart >= oldN - suffix) suffixStart = i;
    else break;
  }
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
  const suffixBound = newN - suffix;
  const maxCand = suffixMeta.length > 0 ? Math.max(...suffixMeta.map((m) => m.tokStart + tokDelta)) : -1;
  const finish = (adoptFrom: number): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    const adoptedSegs = suffixCand.slice(adoptFrom);
    const adoptedKids: H[] = [];
    for (const s of adoptedSegs) {
      for (let i = 0; i < s.kidCount; i++) {
        adoptedKids.push(shift(oldRootHs[s.kidStart + i]!, byteDelta, tokDelta));
      }
    }
    const children: H[] = [...prefixKids, ...midKids, ...adoptedKids];
    const newSegs: Seg[] = [];
    const newEntries: EntryMeta[] = [];
    let kOff = 0;
    for (let i = 0; i < prefixSegs.length; i++) {
      const s = prefixSegs[i]!;
      const m = { ...prefixMeta[i]!, kidStart: kOff };
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart, tokEnd: s.tokEnd, ext: s.ext });
      newEntries.push(m);
      kOff += s.kidCount;
    }
    for (let i = 0; i < midSegs.length; i++) {
      const s = midSegs[i]!;
      const m = { ...midMeta[i]!, kidStart: kOff };
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart, tokEnd: s.tokEnd, ext: s.ext });
      newEntries.push(m);
      kOff += s.kidCount;
    }
    const adoptedMeta = suffixMeta.slice(adoptFrom);
    for (let i = 0; i < adoptedSegs.length; i++) {
      const s = adoptedSegs[i]!;
      const em = { ...adoptedMeta[i]! };
      shiftEntryMeta(em, byteDelta, tokDelta);
      em.kidStart = kOff;
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart + tokDelta, tokEnd: s.tokEnd + tokDelta, ext: s.ext + tokDelta });
      newEntries.push(em);
      kOff += s.kidCount;
    }
    const offset = newEntries.length > 0 ? newEntries[0]!.off : 0;
    const end = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.end : offset;
    const tokStart = newEntries.length > 0 ? newEntries[0]!.tokStart : 0;
    const tokEnd = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.tokEnd : 0;
    _bSave = tokStart;
    const savePos = pos;
    pos = tokEnd;
    const r = builder.node(${J(entryCst)}, children, offset, end);
    pos = savePos;
    if (r === null || Array.isArray(r)) return null;
    return { root: r as H, segs: newSegs, entries: newEntries, entryHs: children, reused: prefixSegs.length + adoptedSegs.length };
  };
  const tryHit = (): { root: H; segs: Seg[]; entries: EntryMeta[]; entryHs: H[]; reused: number } | null => {
    if (pos < suffixBound) return null;
    if (suffixCand.length === 0) {
      if (pos === newN) return finish(0);
      return null;
    }
    const hit = suffixMeta.findIndex((m) => m.tokStart + tokDelta === pos);
    if (hit >= 0) return finish(hit);
    return null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
  ${hasHeadB ? `if (prefixLen === 0) {
    const spans: BWSpan[] = [];
    const pair = parseHeadSegW(midKids, spans);
    if (pair) {
      midSegs.push({ kidStart: 0, kidCount: pair.seg.kidCount, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
      midMeta.push({ ...pair.meta, kidStart: 0 });
      const hit = tryHit();
      if (hit) return hit;
      if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
    }
  }
  ` : ''}for (;;) {
    if (pos >= toks.length) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit();
    }
    const before = midKids.length;
    const spans: BWSpan[] = [];
    const pair = parseLoopSegW(midKids, spans);
    if (pair === null) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit();
    }
    midSegs.push({ kidStart: before, kidCount: midKids.length - before, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
    midMeta.push({ tokStart: pair.meta.tokStart, tokEnd: pair.meta.tokEnd, ext: pair.meta.ext, off: pair.meta.off, end: pair.meta.end, kidStart: 0, kidCount: midKids.length - before });
    const hit = tryHit();
    if (hit) return hit;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
}
` : ''}
function createDocWithBuilder<H>(src: string, opts: { validate?: boolean; builder: Builder<H> }): { text(): string; root(): H | null; align(): Align | null; edit(edits: Edit[]): H | null } {
  const builder = opts.builder;
  const validate = opts.validate === true;
  const supportsShift = typeof builder.shift === 'function';
  const shift = supportsShift ? builder.shift!.bind(builder) : null;
  let text = src;
  let prevToks = ${doc.initToks};
  let align: Align | null = null;${shapeB ? `
  let segs: Seg[] = [];` : ''}${doc.topReuse ? `
  let entries: EntryMeta[] = [];
  let entryHs: H[] = [];` : ''}
  let root: H | null = null;
  {
    const got = parseWithMeta(src, prevToks, builder);
    root = got.root;${doc.topReuse ? `
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
      try {
${doc.editBody}
      const core = { ...computeAlign(oldText, oldToks, text, prevToks), relexed };
      const byteDelta = text.length - oldText.length;
      let reused = 0;
      let next: H | null = null;
      const forceFresh = !supportsShift || root === null;${shapeA ? `
      if (!forceFresh) {
        const got = tryReuseTopW(builder, shift!, entryHs, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix);
        if (got) { next = got.root; entries = got.entries; entryHs = got.entryHs; reused = got.reused; }
      }` : ''}${shapeB ? `
      if (!forceFresh && segs.length > 0) {
        const got = tryReuseSegW(builder, shift!, entryHs, segs, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix);
        if (got) { next = got.root; segs = got.segs; entries = got.entries; entryHs = got.entryHs; reused = got.reused; }
      }` : ''}
      if (next === null) {
        let got = parseWithMeta(text, prevToks, builder);
        if (got.root === null) { prevToks = ${doc.freshMeta}; got = parseWithMeta(text, prevToks, builder); }
        next = got.root;${doc.topReuse ? `
        entries = got.entries;
        entryHs = got.entryHs as H[];` : ''}${shapeB ? `
        segs = got.segs;` : ''}
        reused = 0;
      }
      root = next;
      if (validate) {
        let streamEq = false;
        try { streamEq = checkStreamEq(text, prevToks); } catch { streamEq = false; }
        // Non-cstBuilder: treeEq reports null (rust SUPPORTS_TREE_EQ=false). D3 asserts stay on CST Doc path.
        align = { ...core, reused, streamEq, treeEq: null };
      } else {
        align = { ...core, reused };
      }
      } catch {
        text = applyEdits(oldText, edits);
        try {
          prevToks = ${doc.freshMeta};
          const got = parseWithMeta(text, prevToks, builder);
          root = got.root;${doc.topReuse ? `
          entries = got.entries;
          entryHs = got.entryHs as H[];` : ''}${shapeB ? `
          segs = got.segs;` : ''}
          align = { oldN: oldToks.length, newN: prevToks.length, prefix: 0, suffix: 0, relexed: prevToks.length, reused: 0 };
        } catch {
          prevToks = [];
          root = null;${doc.topReuse ? `
          entries = [];
          entryHs = [];` : ''}${shapeB ? `
          segs = [];` : ''}
          align = { oldN: oldToks.length, newN: 0, prefix: 0, suffix: 0, relexed: 0, reused: 0 };
        }
      }
      return root;
    },
  };
}

/**
 * createDoc: default (no builder / cstBuilder) keeps the CST fast path (createDocCst).
 * Consumer builders → parseWith + optional shift reuse.
 */
export function createDoc<H = Node>(src: string, opts?: { validate?: boolean; builder?: Builder<H> }): { text(): string; root(): H | null; align(): Align | null; edit(edits: Edit[]): H | null } {
  if (opts?.builder != null && opts.builder !== (cstBuilder as unknown as Builder<H>)) {
    return createDocWithBuilder(src, opts as { validate?: boolean; builder: Builder<H> });
  }
  return createDocCst(src, opts) as { text(): string; root(): H | null; align(): Align | null; edit(edits: Edit[]): H | null };
}
`;
}

function docEditBlock(ir: ParserIR, shared: SharedAlgorithms): { code: string; parts: DocEditParts } {
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse && topReuse.kind === 'B' && topReuse.hasHead);
  const entryRule = ir.rules.find((r) => r.name === ir.entry);
  const entryCst = entryRule && 'cstName' in entryRule ? entryRule.cstName : ir.entry;
  const relexFamily = `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.relexFamily(ir)}\n`;
  const editBody = `      [text, prevToks, relexed] = relexEdits(oldText, oldToks, edits);`;
  const initToks = 'scanMeta(src)';
  // True fresh re-lex when window relex left a stale stream (unterminated → closed restore).
  const freshMeta = 'scanMeta(text)';
  const reuseFns = topReuse ? `
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
function shiftSubtree(n: Cst, byteDelta: number, tokDelta: number): void {
  n.offset += byteDelta;
  n.end += byteDelta;
  if ('children' in n) for (const c of n.children) shiftSubtree(c, byteDelta, tokDelta);
}
function shiftEntryMeta(m: EntryMeta, byteDelta: number, tokDelta: number): void {
  m.tokStart += tokDelta;
  m.tokEnd += tokDelta;
  m.ext += tokDelta;
  m.off += byteDelta;
  m.end += byteDelta;
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
function tryReuseTop(oldRoot: Node, oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number, validate: boolean): { root: Node; entries: EntryMeta[]; reused: number } | null {
  if (validate) assertEntriesVsNodes(oldEntries, oldRoot);
  const oldKids = oldRoot.children as Node[];
  let prefixLen = 0;
  while (prefixLen < oldEntries.length) {
    if (oldEntries[prefixLen]!.ext <= prefix) prefixLen++;
    else break;
  }
  let suffixStart = oldEntries.length;
  for (let i = oldEntries.length - 1; i >= prefixLen; i--) {
    if (oldEntries[i]!.tokStart >= oldN - suffix) suffixStart = i;
    else break;
  }
  const prefixKids = oldKids.slice(0, prefixLen);
  const suffixCand = oldKids.slice(suffixStart);
  const prefixMeta = oldEntries.slice(0, prefixLen);
  const suffixMeta = oldEntries.slice(suffixStart);
  const tokDelta = newN - oldN;
  _src = newText;
  toks = toksFromMeta(newText, newMeta);
  pos = prefixLen > 0 ? prefixMeta[prefixLen - 1]!.tokEnd : 0;
  const mid: Node[] = [];
  const midMeta: EntryMeta[] = [];
  const suffixBound = newN - suffix;
  const maxCand = suffixMeta.length > 0 ? Math.max(...suffixMeta.map((m) => m.tokStart + tokDelta)) : -1;
  const finish = (adoptFrom: number): { root: Node; entries: EntryMeta[]; reused: number } => {
    const adopted = suffixCand.slice(adoptFrom);
    for (const s of adopted) shiftSubtree(s, byteDelta, tokDelta);
    const children: Cst[] = [...prefixKids, ...mid, ...adopted];
    const adoptedMeta = suffixMeta.slice(adoptFrom);
    const newEntries: EntryMeta[] = new Array(prefixMeta.length + midMeta.length + adoptedMeta.length);
    let ei = 0;
    for (let i = 0; i < prefixMeta.length; i++) newEntries[ei++] = prefixMeta[i]!;
    for (let i = 0; i < midMeta.length; i++) newEntries[ei++] = midMeta[i]!;
    for (let i = 0; i < adoptedMeta.length; i++) {
      const m = adoptedMeta[i]!;
      shiftEntryMeta(m, byteDelta, tokDelta);
      newEntries[ei++] = m;
    }
    const offset = newEntries.length > 0 ? newEntries[0]!.off : 0;
    const end = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.end : offset;
    return { root: { rule: oldRoot.rule, children, offset, end }, entries: newEntries, reused: prefixKids.length + adopted.length };
  };
  const tryHit = (): { root: Node; entries: EntryMeta[]; reused: number } | null => {
    if (pos < suffixBound) return null;
    if (suffixCand.length === 0) {
      if (pos === newN) return finish(0);
      return null;
    }
    const hit = suffixMeta.findIndex((m) => m.tokStart + tokDelta === pos);
    if (hit >= 0) return finish(hit);
    return null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
  for (;;) {
    if (pos >= toks.length) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit() ?? null;
    }
    lookReset();
    const sp = pos;
    const n = parseTopOne();
    if (n === null) { back(sp); return null; }
    midMeta.push({ tokStart: sp, tokEnd: pos, ext: Math.max(pos, lookEnd()), off: n.offset, end: n.end, kidStart: 0, kidCount: 1 });
    mid.push(n);
    const hit = tryHit();
    if (hit) return hit;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
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
function tryReuseSeg(oldRoot: Node, oldSegs: Seg[], oldEntries: EntryMeta[], newText: string, newMeta: AlignMeta[], byteDelta: number, oldN: number, newN: number, prefix: number, suffix: number, validate: boolean): { root: Node; segs: Seg[]; entries: EntryMeta[]; reused: number } | null {
  if (oldSegs.length === 0) return null;
  if (validate) assertEntriesVsSegs(oldEntries, oldSegs, oldRoot);
  let prefixLen = 0;
  while (prefixLen < oldEntries.length) {
    if (oldEntries[prefixLen]!.ext <= prefix) prefixLen++;
    else break;
  }
  let suffixStart = oldEntries.length;
  for (let i = oldEntries.length - 1; i >= prefixLen; i--) {
    if (oldEntries[i]!.tokStart >= oldN - suffix) suffixStart = i;
    else break;
  }
  const prefixSegs = oldSegs.slice(0, prefixLen);
  const suffixCand = oldSegs.slice(suffixStart);
  const prefixMeta = oldEntries.slice(0, prefixLen);
  const suffixMeta = oldEntries.slice(suffixStart);
  const oldKids = oldRoot.children;
  const prefixKids: Cst[] = [];
  for (const s of prefixSegs) {
    for (let i = 0; i < s.kidCount; i++) prefixKids.push(oldKids[s.kidStart + i]!);
  }
  const tokDelta = newN - oldN;
  _src = newText;
  toks = toksFromMeta(newText, newMeta);
  pos = prefixLen > 0 ? prefixMeta[prefixLen - 1]!.tokEnd : 0;
  const midKids: Cst[] = [];
  const midSegs: Seg[] = [];
  const midMeta: EntryMeta[] = [];
  const suffixBound = newN - suffix;
  const maxCand = suffixMeta.length > 0 ? Math.max(...suffixMeta.map((m) => m.tokStart + tokDelta)) : -1;
  const finish = (adoptFrom: number): { root: Node; segs: Seg[]; entries: EntryMeta[]; reused: number } => {
    const adoptedSegs = suffixCand.slice(adoptFrom);
    const adoptedKids: Cst[] = [];
    for (const s of adoptedSegs) {
      for (let i = 0; i < s.kidCount; i++) {
        const k = oldKids[s.kidStart + i]!;
        shiftSubtree(k, byteDelta, tokDelta);
        adoptedKids.push(k);
      }
    }
    const children: Cst[] = [...prefixKids, ...midKids, ...adoptedKids];
    const newSegs: Seg[] = [];
    const newEntries: EntryMeta[] = [];
    let kOff = 0;
    for (let i = 0; i < prefixSegs.length; i++) {
      const s = prefixSegs[i]!;
      const m = prefixMeta[i]!;
      m.kidStart = kOff;
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart, tokEnd: s.tokEnd, ext: s.ext });
      newEntries.push(m);
      kOff += s.kidCount;
    }
    for (let i = 0; i < midSegs.length; i++) {
      const s = midSegs[i]!;
      const m = midMeta[i]!;
      m.kidStart = kOff;
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart, tokEnd: s.tokEnd, ext: s.ext });
      newEntries.push(m);
      kOff += s.kidCount;
    }
    const adoptedMeta = suffixMeta.slice(adoptFrom);
    for (let i = 0; i < adoptedSegs.length; i++) {
      const s = adoptedSegs[i]!;
      const em = adoptedMeta[i]!;
      shiftEntryMeta(em, byteDelta, tokDelta);
      em.kidStart = kOff;
      newSegs.push({ kidStart: kOff, kidCount: s.kidCount, tokStart: s.tokStart + tokDelta, tokEnd: s.tokEnd + tokDelta, ext: s.ext + tokDelta });
      newEntries.push(em);
      kOff += s.kidCount;
    }
    const offset = newEntries.length > 0 ? newEntries[0]!.off : 0;
    const end = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.end : offset;
    return { root: { rule: oldRoot.rule, children, offset, end }, segs: newSegs, entries: newEntries, reused: prefixSegs.length + adoptedSegs.length };
  };
  const tryHit = (): { root: Node; segs: Seg[]; entries: EntryMeta[]; reused: number } | null => {
    if (pos < suffixBound) return null;
    if (suffixCand.length === 0) {
      if (pos === newN) return finish(0);
      return null;
    }
    const hit = suffixMeta.findIndex((m) => m.tokStart + tokDelta === pos);
    if (hit >= 0) return finish(hit);
    return null;
  };
  {
    const early = tryHit();
    if (early) return early;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
  ${hasHeadB ? `if (prefixLen === 0) {
    const pair = parseHeadSeg(midKids);
    if (pair) {
      midSegs.push({ kidStart: 0, kidCount: pair.seg.kidCount, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
      midMeta.push({ ...pair.meta, kidStart: 0 });
      const hit = tryHit();
      if (hit) return hit;
      if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
    }
  }
  ` : ''}for (;;) {
    if (pos >= toks.length) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit() ?? null;
    }
    const before = midKids.length;
    const pair = parseLoopSeg(midKids);
    if (pair === null) {
      if (suffixCand.length === 0 && pos === newN) return finish(0);
      return tryHit() ?? null;
    }
    midSegs.push({ kidStart: before, kidCount: midKids.length - before, tokStart: pair.seg.tokStart, tokEnd: pair.seg.tokEnd, ext: pair.seg.ext });
    midMeta.push({ tokStart: pair.meta.tokStart, tokEnd: pair.meta.tokEnd, ext: pair.meta.ext, off: pair.meta.off, end: pair.meta.end, kidStart: 0, kidCount: midKids.length - before });
    const hit = tryHit();
    if (hit) return hit;
    if (suffixCand.length > 0 && maxCand >= 0 && pos > maxCand) return null;
  }
}
` : ''}` : `
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
`;
  const editParse = shapeA
    ? `      const byteDelta = text.length - oldText.length;
      let reused = 0;
      let next: Node | null = null;
      if (root !== null) {
        const got = tryReuseTop(root, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix, validate);
        if (got) { next = got.root; entries = got.entries; reused = got.reused; }
      }
      if (next === null) {
        _src = text;
        next = parseTokens(toksFromMeta(text, prevToks)) as Node | null;
        if (next === null) { prevToks = ${freshMeta}; next = parseTokens(toksFromMeta(text, prevToks)) as Node | null; }
        entries = next !== null ? _entries.slice() : [];
        reused = 0;
      }
      root = next;
      let streamEq = false, treeEq = false;
      if (validate) { try { streamEq = checkStreamEq(text, prevToks); treeEq = checkTreeEq(text, root); } catch { streamEq = false; treeEq = root === null; } }
      align = validate ? { ...core, reused, streamEq, treeEq } : { ...core, reused };`
    : shapeB
    ? `      const byteDelta = text.length - oldText.length;
      let reused = 0;
      let next: Node | null = null;
      let nextSegs: Seg[] | null = null;
      if (root !== null && segs.length > 0) {
        const got = tryReuseSeg(root, segs, entries, text, prevToks, byteDelta, core.oldN, core.newN, core.prefix, core.suffix, validate);
        if (got) { next = got.root; nextSegs = got.segs; entries = got.entries; reused = got.reused; }
      }
      if (next === null) {
        _src = text;
        next = parseTokens(toksFromMeta(text, prevToks)) as Node | null;
        if (next === null) { prevToks = ${freshMeta}; next = parseTokens(toksFromMeta(text, prevToks)) as Node | null; nextSegs = next !== null ? _segs.slice() : []; }
        else { nextSegs = _segs.slice(); }
        entries = next !== null ? _entries.slice() : [];
        reused = 0;
      }
      root = next;
      segs = nextSegs ?? [];
      let streamEq = false, treeEq = false;
      if (validate) { try { streamEq = checkStreamEq(text, prevToks); treeEq = checkTreeEq(text, root); } catch { streamEq = false; treeEq = root === null; } }
      align = validate ? { ...core, reused, streamEq, treeEq } : { ...core, reused };`
    : `      const reused = 0;
      _src = text;
      root = parseTokens(toksFromMeta(text, prevToks)) as Node | null;
      if (root === null) { prevToks = ${freshMeta}; root = parseTokens(toksFromMeta(text, prevToks)) as Node | null; }
      let streamEq = false, treeEq = false;
      if (validate) { try { streamEq = checkStreamEq(text, prevToks); treeEq = checkTreeEq(text, root); } catch { streamEq = false; treeEq = root === null; } }
      align = validate ? { ...core, reused, streamEq, treeEq } : { ...core, reused };`;
  const docSegInit = shapeB
    ? `
  let segs: Seg[] = [];`
    : '';
  const docEntriesInit = topReuse
    ? `
  let entries: EntryMeta[] = [];`
    : '';
  const docParseInit = shapeB
    ? `  let root: Node | null = parse(src) as Node | null;
  segs = root !== null ? _segs.slice() : [];
  entries = root !== null ? _entries.slice() : [];`
    : shapeA
    ? `  let root: Node | null = parse(src) as Node | null;
  entries = root !== null ? _entries.slice() : [];`
    : `  let root: Node | null = parse(src) as Node | null;`;
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
${relexFamily}
function computeAlign(oldText: string, oldToks: AlignMeta[], newText: string, newToks: AlignMeta[]): Omit<Align, 'relexed' | 'reused' | 'streamEq' | 'treeEq'> {
  const oldN = oldToks.length, newN = newToks.length;
  let prefix = 0;
  while (prefix < oldN && prefix < newN) {
    const o = oldToks[prefix], n = newToks[prefix];
    if (o.kid !== n.kid || o.off !== n.off || o.end !== n.end || am_nl(o) !== am_nl(n)) break;
    if (am_text(oldText, o) !== am_text(newText, n)) break;
    prefix++;
  }
  const delta = newText.length - oldText.length;
  const minN = Math.min(oldN, newN);
  let suffix = 0;
  while (prefix + suffix < minN) {
    const o = oldToks[oldN - 1 - suffix], n = newToks[newN - 1 - suffix];
    if (o.kid !== n.kid || am_nl(o) !== am_nl(n) || n.off !== o.off + delta || n.end !== o.end + delta) break;
    if (am_text(oldText, o) !== am_text(newText, n)) break;
    suffix++;
  }
  return { oldN, newN, prefix, suffix };
}
function toksFromMeta(text: string, meta: AlignMeta[]): Tok[] {
  return meta.map((m) => {
    const tx = am_text(text, m);
    return mk_tok(m.off, m.end, am_nl(m), m.kid, lid_of(tx));
  });
}
${reuseFns}/** CST fast-path Doc (unchanged semantics). createDoc() without consumer builder dispatches here. */
function createDocCst(src: string, opts?: { validate?: boolean }): { text(): string; root(): Node | null; align(): Align | null; edit(edits: Edit[]): Node | null } {
  const validate = opts?.validate === true;
  let text = src;
  let prevToks = ${initToks};
  let align: Align | null = null;${docSegInit}${docEntriesInit}
${docParseInit}
  return {
    text(): string { return text; },
    root(): Node | null { return root; },
    align(): Align | null { return align; },
    edit(edits: Edit[]): Node | null {
      const oldText = text, oldToks = prevToks;
      let relexed = 0;
      try {
${editBody}
      const core = { ...computeAlign(oldText, oldToks, text, prevToks), relexed };
${editParse}
      } catch {
        text = applyEdits(oldText, edits);
        try {
          prevToks = ${freshMeta};
          _src = text;
          root = parseTokens(toksFromMeta(text, prevToks)) as Node | null;${shapeA || shapeB ? `
          entries = root !== null ? _entries.slice() : [];` : ''}${shapeB ? `
          segs = root !== null ? _segs.slice() : [];` : ''}
          align = { oldN: oldToks.length, newN: prevToks.length, prefix: 0, suffix: 0, relexed: prevToks.length, reused: 0 };
        } catch {
          prevToks = [];
          root = null;${shapeA || shapeB ? `
          entries = [];` : ''}${shapeB ? `
          segs = [];` : ''}
          align = { oldN: oldToks.length, newN: 0, prefix: 0, suffix: 0, relexed: 0, reused: 0 };
        }
      }
      return root;
    },
  };
}`;
  return {
    code,
    parts: {
      editBody,
      initToks,
      freshMeta,
      shapeA: !!shapeA,
      shapeB: !!shapeB,
      hasHeadB,
      topReuse: !!topReuse,
      entryCst,
    },
  };
}

// ─── Shape AST codegen (SH1/SH2-0) ────────────────────────────────────────────

type ShapeStepKind =
  | 'lit' | 'tok' | 'rule' | 'ruleBp' | 'star' | 'opt' | 'sep'
  | 'altlit' | 'alt' | 'look' | 'ahead' | 'seq' | 'sameLine' | 'suppress';
type ShapePrattKind =
  | 'atom' | 'group' | 'prefix' | 'binary' | 'postfix' | 'postfixTok'
  | 'led' | 'nudSeq' | 'nudCapped' | 'template';
type ShapeUnsupported = { rule: string; construct: string };

const SHAPE_STEP_KINDS: readonly ShapeStepKind[] = [
  'lit', 'tok', 'rule', 'ruleBp', 'star', 'opt', 'sep',
  'altlit', 'alt', 'look', 'ahead', 'seq', 'sameLine', 'suppress',
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
      if (r.cstName === 'Stmt' || r.name === 'Stmt') lines.push(`export type Statement = ${name};`);
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
      if (r.cstName === 'Expr' || r.name === 'Expr') lines.push(`export type Expression = ${name};`);
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
      case 'suppress': return s.steps.some(visible);
      case 'sep': return visible(s.elem);
      case 'altlit': return s.opts.some((o) => !leafDropped(o.ttype, leaves));
      case 'alt': return s.branches.some((b) => b.some(visible));
      case 'look':
      case 'ahead':
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
      case 'look': {
        const nv = local('Not');
        return `(() => { const ${nv}: unknown[] = []; return ${s.is ? '' : '!'}_shapeProbe(${nv}, _ap, () => ${emitSteps(ctx.look[s.id]!, nv)}); })()`;
      }
      case 'suppress':
        return `(() => { _suppressNext = new Set([${s.connectors.map((c) => lidOf(ids, c)).join(', ')}]); const _r = (${emitSteps(s.steps, sink)}); _suppressNext = null; return _r; })()`;
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

function emitAstRdRule(r: RdRule, sir: ShapeIRRule, ids: LexIdPlan, shapeIR: ShapeIR, parentCtx: ShapeEmitCtx): string {
  const ctx = newShapeEmitCtx(r.name, parentCtx.look);
  const leaves = shapeIR.leaves;
  const spans = shapeIR.spans;
  const shape = sir.shape;

  const finalize = (code: string): string => {
    mergeShapeEmitCtx(parentCtx, ctx);
    return code;
  };

  if (shape.kind === 'drop') {
    return finalize(`function parseAst${r.name}(): null { const sp = pos; if (parse${r.name}() === null) { pos = sp; return null; } return null; }`);
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
  const cst = parse${r.name}();
  if (cst === null) return null;
  return { type: ${J(r.cstName)}, children: cst };
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
        finish = `return { type: ${J(r.cstName)}, children: __SK__, arm: ${J(arm.name)}, alt: __ALT__ };`;
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
    `{ type: ${J(r.cstName)}, children: ${kidsExpr}, headText: _shapeHeadText(${kidsExpr}[0])${spanKeep(
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

  const ledGuard = (i: number, lid: number) => {
    const parts: string[] = [];
    if (r.ledAccessTail[i]) parts.push('!tailClosed');
    if (r.ledLbp[i] !== null && r.ledLbp[i] !== undefined) parts.push(`${r.ledLbp[i]} > minBp`);
    if (r.ledSameLine[i]) parts.push('!t.nl');
    if (r.ledNotLeftLeaf[i]) parts.push(`!${J(r.ledNotLeftLeaf[i])}.includes(_shapeHeadText(left))`);
    parts.push(`(_suppressCur === null || !_suppressCur.has(${lid}))`);
    return parts.join(' && ');
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
        return `      if (${ledGuard(i, lid)}) {
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
  _suppressNext = null;
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
  const tplHelper = tpl ? `function _shapeTplSnap(): { pos: number; capped: boolean; sn: Set<number> | null; sc: Set<number> | null } {
  return { pos, capped: _capped, sn: _suppressNext, sc: _suppressCur };
}
function _shapeTplRestore(s: { pos: number; capped: boolean; sn: Set<number> | null; sc: Set<number> | null }): void {
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
    return emitAstRdRule(r, sir, ids, shapeIR, cov);
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
  const root = parseAst${entry}();
  return root !== null && pos === toks.length ? (root as ${rootType}) : null;
}
`;
}

const TS_TYPES: Record<Ty, string> = {
  int: 'number', lid: 'number', depth: 'number', bool: 'boolean', str: 'string', meta: 'AlignMeta', tok: 'Tok', edit: 'Edit',
  metas: 'AlignMeta[]', toks: 'Tok[]', bools: 'boolean[]', depths: 'number[]', edits: 'Edit[]',
};
// Operator spelling and binding strength; unary is 90, a negative literal 7.
const TS_OPS: Record<BinOp, [string, number]> = {
  or: ['||', 1], and: ['&&', 2], eq: ['===', 3], ne: ['!==', 3], lt: ['<', 4], le: ['<=', 4], gt: ['>', 4], ge: ['>=', 4], shr: ['>>', 5], add: ['+', 6], sub: ['-', 6],
};
const TS_IND = '  ';
const tsWrap = (r: R, min: number): string => (r.prec < min ? `(${r.c})` : r.c);
const tsBlock = (lines: string[]): string[] => lines.map((l) => TS_IND + l);

// Shared-algorithm lowering: untyped numbers, GC-managed arrays (capacity is never reserved).
const tsLowering: Lowering = {
  units: UNITS,
  ident: (n) => n,
  num: { int: 'number', lid: 'number', depth: 'number' },
  type: (t) => TS_TYPES[t],
  owns: false,
  charSet: (name, rs) => `const ${name} = /*#__PURE__*/ (() => { const a = new Uint8Array(256); for (const [lo, hi] of [${rs.map(([lo, hi]) => `[${lo},${hi}]`).join(', ')}]) for (let i = lo; i <= hi; i++) a[i] = 1; return a; })();`,
  expr: {
    literal: (v) => ({ c: typeof v === 'string' ? JSON.stringify(v) : String(v), prec: typeof v === 'number' && v < 0 ? 7 : ATOM }),
    not: (r) => ({ c: `!${tsWrap(r, ATOM)}`, prec: 90 }),
    bin: (op, a, b) => {
      const [sp, p] = TS_OPS[op];
      const side = (r: R, right: boolean): string =>
        (r.prec < p || (right && r.prec === p) || (op === 'shr' && r.prec < ATOM) || (COMPARISON.has(op) && r.prec >= 3 && r.prec <= 4) ? `(${r.c})` : r.c);
      return { c: `${side(a, false)} ${sp} ${side(b, true)}`, prec: p };
    },
    call: (name, args) => `${name}(${args.join(', ')})`,
    len: (cx, l) => cx.atom(`${tsWrap(l, ATOM)}.length`, 'int', 'number'),
    code: (cx, s, i) => cx.atom(`${tsWrap(s, ATOM)}.charCodeAt(${i.c})`, 'int', 'number'),
    hasAt: (cx, s, i, lit) => cx.atom(`${tsWrap(s, ATOM)}.startsWith(${J(lit)}, ${i.c})`, 'bool', 'bool'),
    inSet: (_cx, set, c) => ({ c: `${set}[${c.c}] === 1`, ty: 'bool', nat: 'bool', prec: TS_OPS.eq[1] }),
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
    return: (vals) => [`return ${vals.length === 1 ? vals[0] : `[${vals.join(', ')}]`};`],
    fn: (f) => [
      ...f.doc.map((l) => `// ${l}`),
      `function ${f.name}(${f.params.map((p) => `${p.name}: ${p.type}`).join(', ')}): ${f.rets.length === 1 ? f.rets[0] : `[${f.rets.join(', ')}]`} {`,
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
      lexStep: (_cx, s) => [`({ ${[s.posName === 'pos' ? 'pos' : `pos: ${s.posName}`, ...s.state].join(', ')} } = lexFrom(${s.text.c}, ${s.pos}, ${[...s.state, s.out].join(', ')}, 1));`],
      shrink: () => [],
    },
  },
};

export const tsTarget = defineTarget({
  name: 'typescript',
  ext: 'ts',
  lowering: tsLowering,
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string {
    const ir = portableIR(grammar);
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
// Whether the token after the current one is in set k (a longest-match candidate's SECOND guard).
function secondIn(k: number): boolean {
  maxLook = Math.max(maxLook, pos + 2);
  return pos + 1 < toks.length && inSet(k, toks[pos + 1]!);
}`;
}

function emitTsLibrary(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
    const reuse = topReusePlan(ir);
    const ruleFns = ir.rules.map((r) => {
      if (r.kind === 'pratt') return prattRule(r, ir.tpl, ids);
      if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids);
      return rdRule(r, ids);
    }).join('\n\n');
    const matchTemplate = ir.tpl ? `// interp: the rule that parses each \`\${…}\` hole — the one the matching reference declares
// (the grammar's expression rule, or the rule a withHoles reference names).
function matchTemplate(interp: () => Node | null): Cst | null {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return null;
  const children: Cst[] = [];
  const save = pos;
  children.push({ tokenType: '$templateHead', offset: t.off, end: t.end }); pos++;
  for (;;) {
    const expr = interp();
    if (expr === null) { back(save); return null; }
    children.push(expr);
    const next = peek();
    if (next === null) { back(save); return null; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) { children.push({ tokenType: '$templateMiddle', offset: next.off, end: next.end }); pos++; continue; }
    if (next.kid === ${kidOf(ids, '$templateTail')}) { children.push({ tokenType: '$templateTail', offset: next.off, end: next.end }); pos++; break; }
    back(save); return null;
  }
  return { rule: '$template', children, offset: children[0].offset, end: children[children.length - 1].end };
}
` : '';
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

${lexer(ir, ids, shared)}

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
let _suppressNext: Set<number> | null = null;
let _suppressCur: Set<number> | null = null;
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
function headLeafText(node: Cst): string {
  let n: Cst = node;
  while ('children' in n && n.children.length > 0) n = n.children[0];
  return _src.slice(n.offset, n.end);
}
function branch(rule: string, kids: Cst[], save: number): Node {
  const offset = kids.length > 0 ? kids[0].offset : (save < toks.length ? toks[save].off : 0);
  const end = kids.length > 0 ? kids[kids.length - 1].end : offset;
  return { rule, children: kids, offset, end };
}
function node(rule: string, kids: Cst[], fallbackOff: number = 0): Node {
  return { rule, children: kids, offset: kids.length ? kids[0].offset : fallbackOff, end: kids.length ? kids[kids.length - 1].end : fallbackOff };
}
function matchLit(lid: number, ttype: string, kids: Cst[]): boolean {
  if (_GT_LIT[lid] !== 0) return _matchComp(lid);
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  if (ttype !== '$punct') kids.push({ tokenType: ttype, offset: t.off, end: t.end }); pos++; return true;
}
function matchTok(kid: number, name: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  kids.push({ tokenType: name, offset: t.off, end: t.end }); pos++; return true;
}
function callRule(fn: () => Node | null, kids: Cst[]): boolean {
  const n = fn();
  if (n === null) return false;
  kids.push(n); return true;
}
function star(once: () => boolean, kids: Cst[]): boolean {
  for (;;) { const sp = pos; const before = kids.length; if (!once()) { back(sp); kids.length = before; break; } }
  return true;
}
function opt(body: () => boolean, kids: Cst[]): boolean {
  const sp = pos; const before = kids.length; if (!body()) { back(sp); kids.length = before; } return true;
}
function sepBy(elem: () => boolean, delimLid: number, kids: Cst[]): boolean {
  // Match interpreter matchSep: restore on elem failure (zero elems OK; trailing delim keeps delim).
  const sp0 = pos; const before0 = kids.length;
  if (!elem()) { back(sp0); kids.length = before0; return true; }
  for (;;) {
    const sp = pos; const before = kids.length;
    if (!matchLit(delimLid, '$punct', kids)) { back(sp); kids.length = before; break; }
    const sp2 = pos; const before2 = kids.length;
    if (!elem()) { back(sp2); kids.length = before2; break; }   // trailing delim OK — keep delim, drop elem pollution
  }
  return true;
}
function altLit(opts: [number, string][], kids: Cst[]): boolean {
  for (const [lid, tt] of opts) if (matchLit(lid, tt, kids)) return true;
  return false;
}

${matchTemplate}${lookFns(ir, ids)}${ruleFns}

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
// The entry rule over a token list of the CURRENT _src (also driven by the edit session).
function parseTokens(tokens: Tok[]): Cst | null {
  toks = tokens;
  pos = 0;
  lookReset();
  const root = parse${ir.entry}();
  return root !== null && pos === toks.length ? root : null;
}

${(() => { const doc = docEditBlock(ir, shared); return doc.code + '\n' + emitBuilderAddon(ir, ids, doc.parts); })()}
`;
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
  const ir = portableIR(grammar);
  const ids = buildLexIdPlan(ir);
  const base = emitTsLibrary(ir, ids, tsTarget.shared);
  if (!opts?.shape) return base;
  return base + emitShapeAstAddon(ir, validateShapeOrThrow(grammar, opts.shape), ids);
}
