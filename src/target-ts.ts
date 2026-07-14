// The TypeScript Target for emit-portable. Renders the language-agnostic ParserIR into a
// self-contained TS parser: a char-class/string/comment lexer, a backtracking recursive-
// descent core, a Pratt expression engine (prefix + binary precedence + mixfix call/member/
// index LEDs), and a CST→JSON printer over stdin. It is the reference rendering — its CST
// is checked byte-for-byte against the interpreter (createParser), so a divergence in the
// portable logic surfaces here before Go/Rust are compiled.
import { type ParserIR, type RdRule, type PrattRule, type Step, type Bracket, type CharRange, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type LexFirstBytes, type LexIdPlan } from './emit-portable.ts';
import { portableIR, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, lidOf, kidOf, lidFlagTable, kidFlagTable, rangesHaveNonAscii, isFirstGuardable, groupByPreserveOrder } from './emit-portable.ts';
import type { Target } from './emit.ts';
import type { CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} === ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

/** Bail predicate: byte in bail set, or (bailNonAscii && ≥128). */
function bailCondTS(v: string, bail: number[], bailNonAscii: boolean): string {
  const parts = bail.map((c) => `${v} === ${c}`);
  if (bailNonAscii) parts.push(`${v} >= 128`);
  return parts.length ? parts.join(' || ') : 'false';
}

/** 256-entry Uint8Array FIRST/CONT table from ASCII-only ranges (codes >127 omitted). */
function emitAsciiBoolTableTS(name: string, rs: CharRange[]): string {
  const ranges = rs
    .filter(([lo]) => lo <= 127)
    .map(([lo, hi]) => `[${Math.max(0, lo)},${Math.min(127, hi)}]`);
  return `const ${name} = /*#__PURE__*/ (() => { const a = new Uint8Array(256); for (const [lo, hi] of [${ranges.join(', ')}]) for (let i = lo; i <= hi; i++) a[i] = 1; return a; })();`;
}

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.lid === ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kid === ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);

/** Emit kid/lid lookup tables into generated lexer source. */
function renderIdTablesTS(ids: LexIdPlan): string {
  const pf = buildLidPrefilter(ids);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  return `const KIND_STR: string[] = ${J(ids.kids)};
const _LIDS: string[] = ${J(ids.lids)};
const _KID_MAP = new Map<string, number>(KIND_STR.map((k, i) => [k, i]));
const _LID_MAP = new Map<string, number>(_LIDS.map((t, i) => [t, i]));
const _LID_MAX_LEN = ${pf.maxByteLen};
const _LID_FIRST_BITS = new Uint8Array([${bitsLit}]);
function kid_of(kind: string): number { return _KID_MAP.get(kind) ?? 0; }
function lid_of(text: string): number {
  const n = text.length;
  if (n === 0 || n > _LID_MAX_LEN) return 0;
  const b0 = text.charCodeAt(0);
  // Ident/@-keyword shape: O(1) length×first-byte miss ⇒ lid 0. Punct first bytes skip the probe.
  if ((b0 >= 65 && b0 <= 90) || (b0 >= 97 && b0 <= 122) || b0 === 95 || b0 === 36 || b0 === 64) {
    if ((_LID_FIRST_BITS[n * 32 + (b0 >> 3)]! & (1 << (b0 & 7))) === 0) return 0;
  }
  return _LID_MAP.get(text) ?? 0;
}
function tok_kind(t: Tok): string { return KIND_STR[t.kid]!; }
function tok_text(src: string, t: Tok): string { return src.slice(t.off, t.end); }
function mk_tok(off: number, end: number, nl: boolean, kid: number, lid: number): Tok { return { off, end, nl, kid, lid }; }
`;
}

import type { TokenPattern } from './types.ts';

// Compile a token-pattern AST to backtracking-free matcher functions `_mN(p): number`
// (returns the new position, or -1 on no match). Greedy `repeat`, ordered `alt`,
// zero-width `lookahead`/`anchor` — the regex-free token-matcher tier.
function ccCond(p: Extract<TokenPattern, { type: 'charClass' }>): string {
  const parts = p.items.map((it) =>
    it.type === 'char' ? `cc === ${it.value.charCodeAt(0)}` : `cc >= ${it.from.charCodeAt(0)} && cc <= ${it.to.charCodeAt(0)}`);
  const inSet = '(' + parts.join(' || ') + ')';
  return p.negate ? `!${inSet}` : inSet;
}
function compilePat(p: TokenPattern, defs: string[]): string {
  const name = `_m${defs.length}`;
  defs.push('');   // reserve the slot (keeps numbering stable across recursion)
  let body: string;
  if (typeof p === 'string') {
    body = `=> _s.startsWith(${J(p)}, p) ? p + ${p.length} : -1`;
  } else switch (p.type) {
    case 'anyChar': body = `=> p < _s.length ? p + 1 : -1`; break;
    case 'charClass': body = `=> { if (p >= _s.length) return -1; const cc = _s.charCodeAt(p); return ${ccCond(p)} ? p + 1 : -1; }`; break;
    case 'seq': { const ms = p.items.map((x) => compilePat(x, defs)); body = `=> { ${ms.map((m) => `p = ${m}(p); if (p < 0) return -1;`).join(' ')} return p; }`; break; }
    case 'alt': { const ms = p.items.map((x) => compilePat(x, defs)); body = `=> { ${ms.map((m) => `{ const r = ${m}(p); if (r >= 0) return r; }`).join(' ')} return -1; }`; break; }
    case 'repeat': { const m = compilePat(p.body, defs); const mx = p.max !== undefined ? `if (c >= ${p.max}) break;` : ''; body = `=> { let q = p, c = 0; for (;;) { const r = ${m}(q); if (r < 0 || r === q) break; q = r; c++; ${mx} } return c >= ${p.min} ? q : -1; }`; break; }
    case 'lookahead': { const m = compilePat(p.body, defs); body = `=> { const r = ${m}(p); return ${p.negate ? 'r < 0' : 'r >= 0'} ? p : -1; }`; break; }
    case 'anchor': body = p.kind === 'start' ? `=> p === 0 ? p : -1` : `=> p === _s.length ? p : -1`; break;
    default: throw new Error(`portable TS lexer: pattern '${(p as { type: string }).type}' unsupported`);
  }
  defs[Number(name.slice(2))] = `const ${name} = (p: number): number ${body};`;
  return name;
}

function scanTok(t: LexTok, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token is scanned by the state machine
  // `emit(...)` threads the lexer state in stateful mode; a plain push otherwise. A skipped
  // token (comment) still records a newline it spans, so `sameLine` sees it.
  const kid = kidOf(ids, name);
  const push = (endExpr: string) => (t.skip
    ? `if (/[\\n\\r\\u2028\\u2029]/.test(src.slice(pos, ${endExpr}))) pendingNl = true; `
    : `${stateful ? 'emit' : 'push'}(pos, ${endExpr}, ${kid}, lid_of(src.slice(pos, ${endExpr}))); `);
  const gate = rxTok !== undefined && name === rxTok ? '!prevIsValue() && ' : '';
  if (t.kind === 'run') return `    if (${gate}${rangeCond('c', t.first)}) {
      let e = pos + 1;
      while (e < n) { const cc = src.charCodeAt(e); if (!${rangeCond('cc', t.cont)}) break; e++; }
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'runBail') {
    // Cont with non-ASCII: refuse tight loop (byte-index unsafe for multi-unit chars in other
    // targets; keep three-target isomorphism — fall back to pattern cascade).
    if (rangesHaveNonAscii(t.cont)) {
      const m = compilePat(t.pattern, defs);
      return `    if (${gate}true) { const e = ${m}(pos); if (e > pos) { ${push('e')}pos = e; continue; } }`;
    }
    const tag = t.name.replace(/[^A-Za-z0-9_]/g, '_');
    const fTab = `_rbF_${tag}`, cTab = `_rbC_${tag}`;
    defs.push(emitAsciiBoolTableTS(fTab, t.first));
    defs.push(emitAsciiBoolTableTS(cTab, t.cont));
    const m = compilePat(t.pattern, defs);
    const bailAt = (v: string) => bailCondTS(v, t.bail, t.bailNonAscii);
    // Entry fallback covers cont-bail chars AND complex-head entry chars (headBail).
    const entryBail = bailCondTS('c', [...new Set([...t.bail, ...t.headBail])].sort((a, b) => a - b), t.bailNonAscii || t.headBailNonAscii);
    return `    if (${gate}${fTab}[c]) {
      let e = pos + 1;
      while (e < n && ${cTab}[src.charCodeAt(e)]) e++;
      if (e >= n || !(${bailAt('src.charCodeAt(e)')})) { ${push('e')}pos = e; continue; }
      { const e2 = ${m}(pos); if (e2 > pos) { ${push('e2')}pos = e2; continue; } }
    } else if (${entryBail}) {
      const e = ${m}(pos); if (e > pos) { ${push('e')}pos = e; continue; }
    }`;
  }
  if (t.kind === 'string') return `    if (${gate}c === ${t.delim.charCodeAt(0)}) {
      let e = pos + 1, closed = false;
      while (e < n) { const ch = src.charCodeAt(e); if (ch === 92) { e += 2; continue; } if (ch === ${t.delim.charCodeAt(0)}) { e++; closed = true; break; } e++; }
      if (closed) { ${push('e')}pos = e; continue; }
    }`;
  if (t.kind === 'line') return `    if (${gate}src.startsWith(${J(t.prefix)}, pos)) {
      let e = pos + ${t.prefix.length};
      while (e < n && src.charCodeAt(e) !== 10) e++;
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'block') return `    if (${gate}src.startsWith(${J(t.open)}, pos)) {
      let e = pos + ${t.open.length};
      while (e < n && !src.startsWith(${J(t.close)}, e)) e++;
      if (e < n) { e += ${t.close.length}; ${push('e')}pos = e; continue; }
    }`;
  const m = compilePat(t.pattern, defs);
  return `    if (${gate}true) { const e = ${m}(pos); if (e > pos) { ${push('e')}pos = e; continue; } }`;
}

function buildLexCandidates(
  ir: ParserIR, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, tplTok: string | undefined,
  punctLine: (p: string) => string,
): { codes: string[]; firsts: (LexFirstBytes | null)[] } {
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of ir.tokens) {
    const code = scanTok(t, defs, stateful, ids, rxTok, tplTok);
    if (!code) continue;
    codes.push(code);
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

function newlineParts(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; boundary: string; ws: string; hooks: string } {
  const commentSkip = nl.comment
    ? `      if (src.startsWith(${J(nl.comment)}, p)) { let e = p; while (e < n && src.charCodeAt(e) !== 10) e++; pos = e; continue; }\n`
    : '';
  return {
    state: `  let lineStart = true, emittedContent = false, flowDepth = 0;
  const _flowOpen = new Set([${nl.flowOpen.map(J).join(', ')}]);
  const _flowClose = new Set([${nl.flowClose.map(J).join(', ')}]);
  const _kidNl = ${kidOf(ids, nl.token)};
`,
    stateFrom: `  const _flowOpen = new Set([${nl.flowOpen.map(J).join(', ')}]);
  const _flowClose = new Set([${nl.flowClose.map(J).join(', ')}]);
  const _kidNl = ${kidOf(ids, nl.token)};
`,
    boundary: `    if (flowDepth === 0 && lineStart) {
      let p = pos;
      while (p < n && src.charCodeAt(p) === 32) p++;
      if (p >= n) { pos = p; lineStart = false; continue; }
      const ch = src.charCodeAt(p);
      if (ch === 10 || ch === 13) {   // LF/CR only — the interpreter's newline mode rejects LS/PS (gen-lexer.ts blank-line check)
        pos = p + 1; if (ch === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
        continue;
      }
      if (ch === 9) {
        let b = p;
        while (b < n && (src.charCodeAt(b) === 32 || src.charCodeAt(b) === 9)) b++;
        if (b >= n) { pos = b; continue; }
        const bc = src.charCodeAt(b);
        if (bc === 10 || bc === 13) {
          pos = b + 1; if (bc === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
          continue;
        }
      }
${commentSkip}      pos = p;
      if (emittedContent) ${pushFn}(pos, pos, ${kidOf(ids, nl.token)}, 0);
      lineStart = false;
      continue;
    }
`,
    ws: `    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) { pos++; continue; }
    if (c === 10 || c === 13) {   // LF/CR only — LS/PS fall through to the unexpected-character throw, matching the interpreter
      pos++; if (c === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
      if (flowDepth === 0) lineStart = true;
      continue;
    }
`,
    hooks: `    if (kid !== _kidNl) emittedContent = true;
    if (kid === 0 && _flowOpen.has(_LIDS[lid]!)) flowDepth++;
    else if (kid === 0 && _flowClose.has(_LIDS[lid]!)) flowDepth = Math.max(0, flowDepth - 1);
`,
  };
}

/** Emit a dense 0/1 number[] bit table (indexed by lid or kid). */
function tsFlagTable(name: string, flags: boolean[]): string {
  return `const ${name}: number[] = [${flags.map((b) => (b ? 1 : 0)).join(', ')}];`;
}

function lexer(ir: ParserIR): string {
  const ids = buildLexIdPlan(ir);
  const defs: string[] = [];
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
    `    if (src.startsWith(${J(p)}, pos)) { ${pushFn}(pos, pos + ${p.length}, 0, ${lidOf(ids, p)}); pos += ${p.length}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, defs, stateful, ids, rx?.regexToken, tpl?.token, punctLine);
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
  const tplState = tpl ? `  const templateStack: number[] = [];
  function scanTplSpan(p: number): { interp: boolean; end: number } {
    while (p < n) {
      if (src.startsWith(${J(tpl.interpOpen)}, p)) return { interp: true, end: p + ${tpl.interpOpen.length} };
      if (src.charCodeAt(p) === 92) { p += 2; continue; }
      if (src.startsWith(${J(tpl.open)}, p)) return { interp: false, end: p + ${tpl.open.length} };
      p++;
    }
    throw new Error('Unterminated template literal at offset ' + p);
  }
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
    const isExprKw = prevKid === KID_IDENT && !!_rxT[prevLid];
    const isParenHead = prevLid === LID_RPAREN && lastClose;
    return !isExprKw && !isParenHead && (!!_divK[prevKid] || !!_divT[prevLid]);
  }
` : '';
  const tplStateFrom = tpl ? `  function scanTplSpan(p: number): { interp: boolean; end: number } {
    while (p < n) {
      if (src.startsWith(${J(tpl.interpOpen)}, p)) return { interp: true, end: p + ${tpl.interpOpen.length} };
      if (src.charCodeAt(p) === 92) { p += 2; continue; }
      if (src.startsWith(${J(tpl.open)}, p)) return { interp: false, end: p + ${tpl.open.length} };
      p++;
    }
    throw new Error('Unterminated template literal at offset ' + p);
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
  // Template dispatch runs at the top of the loop, before token/punct scanning.
  const tplDispatch = tpl ? `    if (templateStack.length > 0 && src.startsWith(${J(tpl.interpClose)}, pos) && templateStack[templateStack.length - 1] === 0) {
      templateStack.pop();
      const sp = scanTplSpan(pos + ${tpl.interpClose.length});
      if (sp.interp) { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateMiddle')}, lid_of(_tx)); templateStack.push(0); }
      else { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateTail')}, lid_of(_tx)); }
      pos = sp.end; continue;
    }
    if (src.startsWith(${J(tpl.open)}, pos)) {
      const sp = scanTplSpan(pos + ${tpl.open.length});
      if (sp.interp) { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, '$templateHead')}, lid_of(_tx)); templateStack.push(0); }
      else { const _tx = src.slice(pos, sp.end); emit(pos, sp.end, ${kidOf(ids, tpl.token)}, lid_of(_tx)); }
      pos = sp.end; continue;
    }
` : '';
  const nlState = nl ? newlineParts(nl, stateful ? 'emit' : 'push', ids).state : '';
  const nlStateFrom = nl ? newlineParts(nl, 'push', ids).stateFrom : '';
  const nlBoundary = nl ? newlineParts(nl, stateful ? 'emit' : 'push', ids).boundary : '';
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
  const loopBody = `${nlBoundary}    const c = src.charCodeAt(pos);
    // JS line terminators LF/CR/LS/PS set newline-before, matching the interpreter (gen-lexer.ts).
${nlWs}${tplDispatch}${cascade}
    throw new Error('Unexpected character at offset ' + pos + ': \\'' + src[pos] + '\\'');`;
  if (rxOnly) {
    return `${renderIdTablesTS(ids)}${rxModuleConsts}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, hasPrev: boolean, bpLid: number, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean } {
  const n = src.length;
  const base = toks.length;
${defs.length ? '  _s = src;\n' : ''}${rxStateFrom}${emitRxOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, 0, 0, false, 0, false, [], false, false, toks);
  return toks;
}`;
  }
  if (tplOnly) {
    return `${renderIdTablesTS(ids)}${rxModuleConsts}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lexFrom(src: string, pos: number, pendingNl: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; templateStack: number[] } {
  const n = src.length;
  const base = toks.length;
${defs.length ? '  _s = src;\n' : ''}${tplStateFrom}${emitTplOnly}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
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
    return `${renderIdTablesTS(ids)}${rxModuleConsts}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lexFrom(src: string, pos: number, pendingNl: boolean, prevLid: number, prevKid: number, hasPrev: boolean, bpLid: number, hasPrev2: boolean, parenHead: boolean[], lastClose: boolean, lastBang: boolean, templateStack: number[], toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; prevLid: number; prevKid: number; hasPrev: boolean; bpLid: number; hasPrev2: boolean; parenHead: boolean[]; lastClose: boolean; lastBang: boolean; templateStack: number[] } {
  const n = src.length;
  const base = toks.length;
${defs.length ? '  _s = src;\n' : ''}${rxStateFrom}${tplStateFrom}${emitRxTpl}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, 0, 0, false, 0, false, [], false, false, [], toks);
  return toks;
}`;
  }
  if (rxOrTpl) {
    return `${renderIdTablesTS(ids)}${rxModuleConsts}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let pos = 0;
  let pendingNl = false;
${defs.length ? '  _s = src;\n' : ''}${rxState}${tplState}${nlState}${emitFn}  while (pos < n) {
${loopBody}
  }
  return toks;
}`;
  }
  if (newlineOnly) {
    return `${renderIdTablesTS(ids)}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lexFrom(src: string, pos: number, pendingNl: boolean, lineStart: boolean, emittedContent: boolean, flowDepth: number, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean; lineStart: boolean; emittedContent: boolean; flowDepth: number } {
  const n = src.length;
  const base = toks.length;
${defs.length ? '  _s = src;\n' : ''}${nlStateFrom}${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
${loopBody}
  }
  return { pos, pendingNl, lineStart, emittedContent, flowDepth };
}
function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  lexFrom(src, 0, false, true, false, 0, toks);
  return toks;
}`;
  }
  return `${renderIdTablesTS(ids)}${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lexFrom(src: string, pos: number, pendingNl: boolean, toks: Tok[], limit?: number): { pos: number; pendingNl: boolean } {
  const n = src.length;
  const base = toks.length;
${defs.length ? '  _s = src;\n' : ''}${pushFnDef}  while (pos < n && (limit === undefined || toks.length - base < limit)) {
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
          ? `{ const sp = pos; const bk = kids.length; const bs = spans.length; if (${br.length ? br.map(sc).join(' && ') : 'true'}) return true; pos = sp; kids.length = bk; spans.length = bs; }`
          : `{ const sp = pos; const bk = kids.length; if (${br.length ? br.map(sc).join(' && ') : 'true'}) return true; pos = sp; kids.length = bk; }`;
        const f = firsts[i] ?? null;
        if (!isGuardable(f, nAlts)) return body;
        return `if (_ft !== null && ${firstCond(f, '_ft', ids)}) ${body}`;
      }).join(' ');
      return `(() => { ${peekInit}${tries} return false; })()`;
    }
    case 'not': return w
      ? `(() => { const sp = pos; const bk = kids.length; const bs = spans.length; const m = ${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'}; pos = sp; kids.length = bk; spans.length = bs; return !m; })()`
      : `(() => { const sp = pos; const bk = kids.length; const m = ${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'}; pos = sp; kids.length = bk; return !m; })()`;
    case 'seq': return `(${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'})`;
    case 'sameLine': return `(() => { const t = peek(); return t !== null && !t.nl; })()`;
    case 'suppress': return `(() => { _suppressNext = new Set([${s.connectors.map((c) => lidOf(ids, c)).join(', ')}]); const _r = (${s.steps.length ? s.steps.map(sc).join(' && ') : 'true'}); _suppressNext = null; return _r; })()`;
  }
}

function predAltBody(branches: Step[][], ids: LexIdPlan, firsts?: FirstSig[], w = false): string {
  const sc = (x: Step) => stepCond(x, ids, w);
  const arms = branches.map((br, i) => `if (${firstCond(firsts![i], 't', ids)}) { if (${br.length ? br.map(sc).join(' && ') : 'true'}) return true; }`).join(' else ');
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
        return `  { const sp = pos; const n = parse${name}(); if (n !== null) return n; pos = sp; }`;
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
  pos = save;
  return null;
}`;
  }
  const alt = (steps: Step[], i: number) => {
    const body = `{ const kids: Cst[] = []; if (${steps.map((x) => stepCond(x, ids)).join(' && ')}) return branch(${J(r.cstName)}, kids, save); pos = save; }`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) return `  ${body}`;
    return `  if (_ft !== null && ${firstCond(r.altFirst[i], '_ft', ids)}) ${body}`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `function parse${r.name}(): Node | null {
  const save = pos;
${needPeek ? '  const _ft = peek();\n' : ''}${r.alts.map(alt).join('\n')}
  return null;
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
  pos = save;
  return null;
}`;
  }
  const alt = (steps: Step[], i: number) => {
    const body = `{ const kids: any[] = []; const spans: BWSpan[] = []; if (${steps.map((x) => stepCond(x, ids, true)).join(' && ')}) return branchW(${J(r.cstName)}, kids, spans, save); pos = save; }`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) return `  ${body}`;
    return `  if (_ft !== null && ${firstCond(r.altFirst[i], '_ft', ids)}) ${body}`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `function parse${r.name}W(): Frame | null {
  const save = pos;
${needPeek ? '  const _ft = peek();\n' : ''}${r.alts.map(alt).join('\n')}
  return null;
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
    maxLook = 0;
    const n = parseTopOneW();
    if (n === null) { pos = sp; break; }
    const ext = Math.max(n.tokEnd, maxLook);
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
  maxLook = 0;
  const kidStart = kids.length;
  const before = kids.length;
  const spanBefore = spans.length;
  optW(() => callRuleW(parse${plan.headRule}W, kids, spans), kids, spans);
  if (kids.length === before) return null;
  const sp0 = spans[spanBefore]!;
  const sp1 = spans[spans.length - 1]!;
  const tokStart = sp0.tokStart;
  const tokEnd = sp1.tokEnd;
  const ext = Math.max(tokEnd, maxLook);
  const meta: EntryMeta = { tokStart, tokEnd, ext, off: sp0.off, end: sp1.end, kidStart, kidCount: 1 };
  return { seg: { kidStart, kidCount: 1, tokStart, tokEnd, ext }, meta };
}
`
    : '';
  return `${headFn}function parseLoopSegW(kids: any[], spans: BWSpan[]): { seg: Seg; meta: EntryMeta } | null {
  const sp = pos;
  const kidStart = kids.length;
  const spanStart = spans.length;
  maxLook = 0;
  if (!matchTokW(${kidOf(ids, plan.loopTok)}, ${J(plan.loopTok)}, kids, spans)) { pos = sp; kids.length = kidStart; spans.length = spanStart; return null; }
  optW(() => callRuleW(parse${plan.loopRule}W, kids, spans), kids, spans);
  const leafSp = spans[spanStart]!;
  const hasStmt = spans.length > spanStart + 1;
  const tokEnd = hasStmt ? spans[spanStart + 1]!.tokEnd : leafSp.tokEnd;
  const end = hasStmt ? spans[spanStart + 1]!.end : leafSp.end;
  const ext = Math.max(tokEnd, maxLook);
  const kidCount = kids.length - kidStart;
  const meta: EntryMeta = { tokStart: leafSp.tokStart, tokEnd, ext, off: leafSp.off, end, kidStart, kidCount };
  return { seg: { kidStart, kidCount, tokStart: leafSp.tokStart, tokEnd, ext }, meta };
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

/** Entry rule that records per-top-kid EntryMeta (+ Node.ext oracle) via parseTopOne (shape A). */
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
    maxLook = 0;
    const n = parseTopOne();
    if (n === null) { pos = sp; break; }
    const ext = Math.max(n.tokEnd, maxLook);
    n.ext = ext; // CST oracle for validate assert; reuse decisions read _entries
    localE.push({ tokStart: n.tokStart, tokEnd: n.tokEnd, ext, off: n.offset, end: n.end, kidStart: kids.length, kidCount: 1 });
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
  maxLook = 0;
  const kidStart = kids.length;
  const before = kids.length;
  opt(() => callRule(parse${plan.headRule}, kids), kids);
  if (kids.length === before) return null;
  const n = kids[before] as Node;
  const ext = Math.max(n.tokEnd, maxLook);
  const meta: EntryMeta = { tokStart: n.tokStart, tokEnd: n.tokEnd, ext, off: n.offset, end: n.end, kidStart, kidCount: 1 };
  return { seg: { kidStart, kidCount: 1, tokStart: n.tokStart, tokEnd: n.tokEnd, ext }, meta };
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
  maxLook = 0;
  if (!matchTok(${kidOf(ids, plan.loopTok)}, ${J(plan.loopTok)}, kids)) { pos = sp; kids.length = kidStart; return null; }
  opt(() => callRule(parse${plan.loopRule}, kids), kids);
  const leaf = kids[kidStart]!;
  const hasStmt = kids.length > kidStart + 1;
  const tokEnd = hasStmt ? kids[kidStart + 1]!.tokEnd : leaf.tokEnd;
  const end = hasStmt ? kids[kidStart + 1]!.end : leaf.end;
  const ext = Math.max(tokEnd, maxLook);
  const kidCount = kids.length - kidStart;
  const meta: EntryMeta = { tokStart: leaf.tokStart, tokEnd, ext, off: leaf.offset, end, kidStart, kidCount };
  return { seg: { kidStart, kidCount, tokStart: leaf.tokStart, tokEnd, ext }, meta };
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
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `  if (t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplate(); return node === null ? null : { rule: ${J(r.cstName)}, children: [node], offset: node.offset, end: node.end, tokStart: node.tokStart, tokEnd: node.tokEnd }; }\n`
    : '';
  const BIN = `{ ${r.binary.map((b) => `${lidOf(ids, b.op)}: { lbp: ${b.lbp}, rbp: ${b.rbp} }`).join(', ')} }`;
  const PRE = `{ ${r.prefix.map((p) => `${lidOf(ids, p.op)}: ${p.rbp}`).join(', ')} }`;
  const atom = `new Set([${r.nudToks.map((k) => kidOf(ids, k)).join(', ')}])`;
  const bracketNudBody = (b: Bracket) => `{
      const save = pos; const kids: Cst[] = [];
      if (${b.steps.map((x) => stepCond(x, ids)).join(' && ')}) return branch(${J(r.cstName)}, kids, save);
      pos = save;   // fall through to the next NUD alternative (e.g. another '${b.first}'-led form)
    }`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `  switch (t.lid) {
${groups.map((g) => `    case ${g.key}:
${g.members.map(({ item: b }) => `      ${bracketNudBody(b)}`).join('\n')}
      break;`).join('\n')}
  }`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.nl');
    if (nll) parts.push(`!${J(nll)}.includes(headLeafText(left))`);
    parts.push(`(_suppressCur === null || !_suppressCur.has(${lid}))`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket) => `{
      const ledSave = pos; const kids: Cst[] = [left];
      if (${b.steps.map((x) => stepCond(x, ids)).join(' && ')}) { left = node(${J(r.cstName)}, kids); continue ledLoop; }
      pos = ledSave; break ledLoop;
    }`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `    switch (t.lid) {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `      if (${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)}) ${ledBody(b)}`);
  return `      case ${lid}:\n${arms.join('\n')}\n        break;`;
}).join('\n')}
    }`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = !!(tpl && r.postfixToks.includes(tpl.token));
    const tplPart = hasTpl ? `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplate(); if (node !== null) { left = { rule: ${J(r.cstName)}, children: [left, node], offset: left.offset, end: node.end, tokStart: left.tokStart, tokEnd: pos }; continue ledLoop; } }` : '';
    return `    switch (t.kid) {
${groups.map((g) => `      case ${g.key}:
        if (!tailClosed) { const leaf: Leaf = { tokenType: tok_kind(t), offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }; pos++; left = { rule: ${J(r.cstName)}, children: [left, leaf], offset: left.offset, end: leaf.end, tokStart: left.tokStart, tokEnd: pos }; continue ledLoop; }
        break;`).join('\n')}
    }${tplPart}`;
  })();
  const POST = `{ ${r.postfix.map((p) => `${lidOf(ids, p.op)}: ${p.lbp}`).join(', ')} }`;
  return `const ${r.name}_BIN: Record<number, { lbp: number; rbp: number }> = ${BIN};
const ${r.name}_PRE: Record<number, number> = ${PRE};
const ${r.name}_POST: Record<number, number> = ${POST};
const ${r.name}_ATOM = ${atom};
function parse${r.name}(): Node | null {
  const prev = _suppressCur; _suppressCur = _suppressNext; _suppressNext = null;
  const r = ${r.name}_bp(0);
  _suppressCur = prev;
  return r;
}
function ${r.name}_bp(minBp: number): Node | null {
  let left = ${r.name}_nud(minBp);
  if (left === null) return null;
  if (_capped) return left;   // an assignment-level arrow admits no led
  let tailClosed = false;
  ${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;
${ledSwitch}
${postfixTokSwitch}
    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp) { const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }; pos++; left = { rule: ${J(r.cstName)}, children: [left, opLeaf], offset: left.offset, end: t.end, tokStart: left.tokStart, tokEnd: pos }; tailClosed = true; continue; }
    const info = ${r.name}_BIN[t.lid];
    if (info === undefined || info.lbp <= minBp) break;
    const ledSave = pos;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 };
    pos++;
    const rhs = ${r.name}_bp(info.rbp);
    if (rhs === null) { pos = ledSave; break; }
    left = { rule: ${J(r.cstName)}, children: [left, opLeaf, rhs], offset: left.offset, end: rhs.end, tokStart: left.tokStart, tokEnd: pos };
  }
  return left;
}
function ${r.name}_nud(minBp: number): Node | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
${r.nudCapped.map((c) => `  if (minBp < ${c.capBp}) { const save = pos; const kids: Cst[] = []; if (${c.steps.length ? c.steps.map((x) => stepCond(x, ids)).join(' && ') : 'true'}) { _capped = true; return branch(${J(r.cstName)}, kids, save); } pos = save; }`).join('\n')}
  // Below is non-capped: a sub-parse may leave _capped set (e.g. grouping a capped arrow),
  // so force it false after — only the capped arms above produce a capped node.
  const _r = ((): Node | null => {
${tplNud}  if (${r.name}_ATOM.has(t.kid)) { const leaf: Leaf = { tokenType: tok_kind(t), offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }; pos++; return { rule: ${J(r.cstName)}, children: [leaf], offset: t.off, end: t.end, tokStart: leaf.tokStart, tokEnd: pos }; }
${bracketNudSwitch}
  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 };
    pos++;
    const operand = ${r.name}_bp(pbp);
    if (operand === null) { pos = save; return null; }
    return { rule: ${J(r.cstName)}, children: [opLeaf, operand], offset: t.off, end: operand.end, tokStart: save, tokEnd: pos };
  }
${r.nudSeqs.map((seq) => `  { const save = pos; const kids: Cst[] = []; if (${seq.length ? seq.map((x) => stepCond(x, ids)).join(' && ') : 'true'}) return branch(${J(r.cstName)}, kids, save); pos = save; }`).join('\n')}
  return null;
  })();
  _capped = false;
  return _r;
}`;
}

/** Builder-mode Pratt — reuses ${name}_BIN/_PRE/_POST/_ATOM tables from the CST emit. */
function prattRuleW(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan): string {
  const cn = J(r.cstName);
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `  if (t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplateW(); return node === null ? null : wrapUnaryW(${cn}, node); }\n`
    : '';
  const bracketNudBody = (b: Bracket) => `{
      const save = pos; const kids: any[] = []; const spans: BWSpan[] = [];
      if (${b.steps.map((x) => stepCond(x, ids, true)).join(' && ')}) return branchW(${cn}, kids, spans, save);
      pos = save;   // fall through to the next NUD alternative (e.g. another '${b.first}'-led form)
    }`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `  switch (t.lid) {
${groups.map((g) => `    case ${g.key}:
${g.members.map(({ item: b }) => `      ${bracketNudBody(b)}`).join('\n')}
      break;`).join('\n')}
  }`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.nl');
    if (nll) parts.push(`!${J(nll)}.includes(headLeafTextW(left))`);
    parts.push(`(_suppressCur === null || !_suppressCur.has(${lid}))`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket) => `{
      const ledSave = pos; const kids: any[] = []; const spans: BWSpan[] = [];
      absorbFrame(kids, spans, left);
      if (${b.steps.map((x) => stepCond(x, ids, true)).join(' && ')}) { left = nodeW(${cn}, kids, spans); continue ledLoop; }
      pos = ledSave; break ledLoop;
    }`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `    switch (t.lid) {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `      if (${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)}) ${ledBody(b)}`);
  return `      case ${lid}:\n${arms.join('\n')}\n        break;`;
}).join('\n')}
    }`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = !!(tpl && r.postfixToks.includes(tpl.token));
    const tplPart = hasTpl ? `
    if (!tailClosed && t.kid === ${kidOf(ids, '$templateHead')}) { const node = matchTemplateW(); if (node !== null) { left = joinFramesW(${cn}, left, node); continue ledLoop; } }` : '';
    return `    switch (t.kid) {
${groups.map((g) => `      case ${g.key}:
        if (!tailClosed) { const lf = leafFrameW(tok_kind(t), t); pos++; left = joinFramesW(${cn}, left, lf); continue ledLoop; }
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
  if (_capped) return left;   // an assignment-level arrow admits no led
  let tailClosed = false;
  ${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'ledLoop: ' : ''}for (;;) {
    const t = peek();
    if (t === null) break;
${ledSwitch}
${postfixTokSwitch}
    const post = ${r.name}_POST[t.lid];
    if (!tailClosed && post !== undefined && post > minBp) { const lf = leafFrameW('$operator', t); pos++; left = joinFramesW(${cn}, left, lf); tailClosed = true; continue; }
    const info = ${r.name}_BIN[t.lid];
    if (info === undefined || info.lbp <= minBp) break;
    const ledSave = pos;
    const lf = leafFrameW('$operator', t);
    pos++;
    const rhs = ${r.name}_bpW(info.rbp);
    if (rhs === null) { pos = ledSave; break; }
    left = joinFramesW(${cn}, left, lf, rhs);
  }
  return left;
}
function ${r.name}_nudW(minBp: number): Frame | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
${r.nudCapped.map((c) => `  if (minBp < ${c.capBp}) { const save = pos; const kids: any[] = []; const spans: BWSpan[] = []; if (${c.steps.length ? c.steps.map((x) => stepCond(x, ids, true)).join(' && ') : 'true'}) { _capped = true; return branchW(${cn}, kids, spans, save); } pos = save; }`).join('\n')}
  // Below is non-capped: a sub-parse may leave _capped set (e.g. grouping a capped arrow),
  // so force it false after — only the capped arms above produce a capped node.
  const _r = ((): Frame | null => {
${tplNud}  if (${r.name}_ATOM.has(t.kid)) { const lf = leafFrameW(tok_kind(t), t); pos++; return wrapUnaryW(${cn}, lf); }
${bracketNudSwitch}
  const pbp = ${r.name}_PRE[t.lid];
  if (pbp !== undefined) {
    const save = pos;
    const lf = leafFrameW('$operator', t);
    pos++;
    const operand = ${r.name}_bpW(pbp);
    if (operand === null) { pos = save; return null; }
    return joinFramesW(${cn}, lf, operand);
  }
${r.nudSeqs.map((seq) => `  { const save = pos; const kids: any[] = []; const spans: BWSpan[] = []; if (${seq.length ? seq.map((x) => stepCond(x, ids, true)).join(' && ') : 'true'}) return branchW(${cn}, kids, spans, save); pos = save; }`).join('\n')}
  return null;
  })();
  _capped = false;
  return _r;
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
  const matchTemplateW = ir.tpl ? `function matchTemplateW(): Frame | null {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return null;
  const kids: any[] = []; const spans: BWSpan[] = [];
  const save = pos;
  {
    const lf = leafFrameW('$templateHead', t); pos++;
    absorbFrame(kids, spans, lf);
  }
  for (;;) {
    const expr = parse${ir.tpl.interpRule}W();
    if (expr === null) { pos = save; return null; }
    absorbFrame(kids, spans, expr);
    const next = peek();
    if (next === null) { pos = save; return null; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) { const lf = leafFrameW('$templateMiddle', next); pos++; absorbFrame(kids, spans, lf); continue; }
    if (next.kid === ${kidOf(ids, '$templateTail')}) { const lf = leafFrameW('$templateTail', next); pos++; absorbFrame(kids, spans, lf); break; }
    pos = save; return null;
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
  for (;;) { const sp = pos; const before = kids.length; const bs = spans.length; if (!once()) { pos = sp; kids.length = before; spans.length = bs; break; } }
  return true;
}
function optW(body: () => boolean, kids: any[], spans: BWSpan[]): boolean {
  const sp = pos; const before = kids.length; const bs = spans.length; if (!body()) { pos = sp; kids.length = before; spans.length = bs; } return true;
}
function sepByW(elem: () => boolean, delimLid: number, kids: any[], spans: BWSpan[]): boolean {
  if (!elem()) return true;
  for (;;) {
    const sp = pos; const before = kids.length; const bs = spans.length;
    if (!matchLitW(delimLid, '$punct', kids, spans)) { pos = sp; kids.length = before; spans.length = bs; break; }
    if (!elem()) break;
  }
  return true;
}
function altLitW(opts: [number, string][], kids: any[], spans: BWSpan[]): boolean {
  for (const [lid, tt] of opts) if (matchLitW(lid, tt, kids, spans)) return true;
  return false;
}
${matchTemplateW}${ruleFnsW}

/** Default CST builder — same object shape as parse(). Uses ambient pos/_bSave for tok spans. */
export const cstBuilder: Builder<Cst> = {
  leaf(tokenType, _kid, _lid, off, end) {
    if (tokenType === '$punct') return null;
    return { tokenType, offset: off, end, tokStart: pos, tokEnd: pos + 1 };
  },
  node(rule, children, off, end) {
    // _bSave is set by branchW/nodeW immediately before this callback.
    return { rule, children, offset: off, end, tokStart: _bSave, tokEnd: pos };
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
  maxLook = 0;
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
  maxLook = 0;
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
    maxLook = 0;
    const sp = pos;
    const fr = parseTopOneW();
    if (fr === null || fr.hs.length !== 1) { pos = sp; return null; }
    const ext = Math.max(fr.tokEnd, maxLook);
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
        text = oldText;
        for (const e of edits) {
          const n = text.length, start = Math.max(0, Math.min(e.start, n)), end = Math.max(start, Math.min(e.end, n));
          text = text.slice(0, start) + e.text + text.slice(end);
        }
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

function docEditBlock(ir: ParserIR): { code: string; parts: DocEditParts } {
  const windowLex = (!ir.regexCtx && !ir.tpl) || !ir.newlineCfg;
  const hasNewline = !!(ir.newlineCfg && !ir.regexCtx && !ir.tpl);
  const rxOnly = !!(ir.regexCtx && !ir.tpl && !ir.newlineCfg);
  const tplOnly = !!(ir.tpl && !ir.regexCtx && !ir.newlineCfg);
  const rxTpl = !!(ir.regexCtx && ir.tpl && !ir.newlineCfg);
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse && topReuse.kind === 'B' && topReuse.hasHead);
  const entryRule = ir.rules.find((r) => r.name === ir.entry);
  const entryCst = entryRule && 'cstName' in entryRule ? entryRule.cstName : ir.entry;
  const adoptSuffix = `for (let j = oIdx + 1; j < oldToks.length; j++) {
            out.push(shift_align(oldToks[j], delta));
          }`;
  const findTokAtOff = `
function findTokAtOff(toks: AlignMeta[], off: number): number {
  let lo = 0, hi = toks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].off < off) lo = mid + 1;
    else if (toks[mid].off > off) hi = mid - 1;
    else return mid;
  }
  return -1;
}`;
  const reconstructParens = `
function reconstructParens(toks: AlignMeta[], text: string, b: number): boolean[] {
  let need = b >= 0 ? toks[b].pd : 0;
  const out: boolean[] = [];
  for (let i = b; i >= 0 && need > 0; i--) {
    const t = toks[i];
    if (am_text(text, t) === '(' && t.pd === need) { out[need - 1] = am_hd(t); need--; }
  }
  return out;
}
function parenStacksEq(a: boolean[], b: boolean[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}`;
  const tplAnchor = `  let maxIdx = -1;
  for (let i = 0; i < oldToks.length; i++) {
    if (oldToks[i].end < start) maxIdx = i;
    else break;
  }
  const rb0 = maxIdx >= 0 ? maxIdx - 1 : -1;
  let rb = -1;
  if (rb0 >= 0) {
    for (let i = rb0; i < oldToks.length; i++) {
      if (oldToks[i].end > start) break;
      if (oldToks[i].td === 0) { rb = i; break; }
    }
  }
  const out: AlignMeta[] = rb >= 0 ? oldToks.slice(0, rb + 1) : [];`;
  const windowHelpers = windowLex ? (hasNewline ? `
function findTokAtOffKind(toks: AlignMeta[], off: number, kid: number): number {
  let lo = 0, hi = toks.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].off < off) lo = mid + 1;
    else if (toks[mid].off > off) hi = mid - 1;
    else { hit = mid; break; }
  }
  if (hit < 0) return -1;
  let start = hit;
  while (start > 0 && toks[start - 1].off === off) start--;
  for (let i = start; i < toks.length && toks[i].off === off; i++) {
    if (toks[i].kid === kid) return i;
  }
  return -1;
}
function windowRelexStep(oldText: string, oldToks: AlignMeta[], newText: string, start: number, end: number, ins: string): { toks: AlignMeta[]; relexed: number } {
  const delta = ins.length - (end - start);
  const editEnd = start + ins.length;
  let maxIdx = -1;
  for (let i = 0; i < oldToks.length; i++) {
    if (oldToks[i].end < start) maxIdx = i;
    else break;
  }
  const rb = maxIdx >= 0 ? maxIdx - 1 : -1;
  const out: AlignMeta[] = rb >= 0 ? oldToks.slice(0, rb + 1) : [];
  let scanOff: number, pendingNl: boolean, lineStart: boolean, emittedContent: boolean, flowDepth: number;
  if (rb >= 0) {
    scanOff = oldToks[rb].end; pendingNl = false; lineStart = false; emittedContent = true; flowDepth = oldToks[rb].fd;
  } else {
    scanOff = 0; pendingNl = false; lineStart = true; emittedContent = false; flowDepth = 0;
  }
  const scratch: Tok[] = [];
  let relexed = 0;
  while (scanOff < newText.length) {
    const before = scratch.length;
    ({ pos: scanOff, pendingNl, lineStart, emittedContent, flowDepth } = lexFrom(newText, scanOff, pendingNl, lineStart, emittedContent, flowDepth, scratch, 1));
    if (scratch.length === before) break;
    const t = scratch[scratch.length - 1];
    out.push(mk_align(t.off, t.end, t.kid, t.nl, flowDepth, 0, false, false, false, 0));
    relexed++;
    if (t.off >= editEnd) {
      const oIdx = findTokAtOffKind(oldToks, t.off - delta, t.kid);
      if (oIdx >= 0) {
        const o = oldToks[oIdx];
        if (o.kid === t.kid && o.end === t.end - delta && am_nl(o) === t.nl && o.fd === flowDepth && am_text(oldText, o) === newText.slice(t.off, t.end)) {
          ${adoptSuffix}
          return { toks: out, relexed };
        }
      }
    }
  }
  return { toks: out, relexed };
}
` : rxOnly ? `${findTokAtOff}${reconstructParens}
function windowRelexStep(oldText: string, oldToks: AlignMeta[], newText: string, start: number, end: number, ins: string): { toks: AlignMeta[]; relexed: number } {
  const delta = ins.length - (end - start);
  const editEnd = start + ins.length;
  let maxIdx = -1;
  for (let i = 0; i < oldToks.length; i++) {
    if (oldToks[i].end < start) maxIdx = i;
    else break;
  }
  const rb = maxIdx >= 0 ? maxIdx - 1 : -1;
  const out: AlignMeta[] = rb >= 0 ? oldToks.slice(0, rb + 1) : [];
  let scanOff: number, pendingNl: boolean;
  let prevLid = 0, prevKid = 0, bpLid = 0, hasPrev = false, hasPrev2 = false;
  let parenHead: boolean[] = [], lastClose = false, lastBang = false;
  if (rb >= 0) {
    const anchor = oldToks[rb];
    scanOff = anchor.end; pendingNl = false;
    prevLid = lid_of(am_text(oldText, anchor)); prevKid = anchor.kid; hasPrev = true;
    if (rb >= 1) { bpLid = lid_of(am_text(oldText, oldToks[rb - 1])); hasPrev2 = true; }
    lastClose = am_lc(anchor); lastBang = am_lb(anchor);
    parenHead = reconstructParens(oldToks, oldText, rb);
  } else {
    scanOff = 0; pendingNl = false;
  }
  const scratch: Tok[] = [];
  let relexed = 0;
  while (scanOff < newText.length) {
    const before = scratch.length;
    ({ pos: scanOff, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang } = lexFrom(newText, scanOff, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, scratch, 1));
    if (scratch.length === before) break;
    const t = scratch[scratch.length - 1];
    out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, parenHead.length, lastClose, lastBang, t.lid === LID_LPAREN ? parenHead[parenHead.length - 1]! : false, 0));
    relexed++;
    if (t.off >= editEnd) {
      const oIdx = findTokAtOff(oldToks, t.off - delta);
      if (oIdx >= 0) {
        const o = oldToks[oIdx];
        const newPrevText = out.length > 1 ? am_text(newText, out[out.length - 2]) : '';
        const oldPrevText = oIdx >= 1 ? am_text(oldText, oldToks[oIdx - 1]) : '';
        const bpOk = newPrevText === oldPrevText;
        const oldStack = reconstructParens(oldToks, oldText, oIdx);
        if (o.pd === parenHead.length && parenStacksEq(oldStack, parenHead) && am_lc(o) === lastClose && am_lb(o) === lastBang && bpOk && o.kid === t.kid && o.end === t.end - delta && am_nl(o) === t.nl && am_text(oldText, o) === newText.slice(t.off, t.end)) {
          ${adoptSuffix}
          return { toks: out, relexed };
        }
      }
    }
  }
  return { toks: out, relexed };
}
` : rxTpl ? `${findTokAtOff}${reconstructParens}
function windowRelexStep(oldText: string, oldToks: AlignMeta[], newText: string, start: number, end: number, ins: string): { toks: AlignMeta[]; relexed: number } {
  const delta = ins.length - (end - start);
  const editEnd = start + ins.length;
${tplAnchor}
  let scanOff: number, pendingNl: boolean;
  let prevLid = 0, prevKid = 0, bpLid = 0, hasPrev = false, hasPrev2 = false;
  let parenHead: boolean[] = [], lastClose = false, lastBang = false;
  let templateStack: number[] = [];
  if (rb >= 0) {
    const anchor = oldToks[rb];
    scanOff = anchor.end; pendingNl = false;
    prevLid = lid_of(am_text(oldText, anchor)); prevKid = anchor.kid; hasPrev = true;
    if (rb >= 1) { bpLid = lid_of(am_text(oldText, oldToks[rb - 1])); hasPrev2 = true; }
    lastClose = am_lc(anchor); lastBang = am_lb(anchor);
    parenHead = reconstructParens(oldToks, oldText, rb);
  } else {
    scanOff = 0; pendingNl = false;
  }
  const scratch: Tok[] = [];
  let relexed = 0;
  while (scanOff < newText.length) {
    const before = scratch.length;
    ({ pos: scanOff, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack } = lexFrom(newText, scanOff, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack, scratch, 1));
    if (scratch.length === before) break;
    const t = scratch[scratch.length - 1];
    out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, parenHead.length, lastClose, lastBang, t.lid === LID_LPAREN ? parenHead[parenHead.length - 1]! : false, templateStack.length));
    relexed++;
    if (t.off >= editEnd) {
      const oIdx = findTokAtOff(oldToks, t.off - delta);
      if (oIdx >= 0) {
        const o = oldToks[oIdx];
        const newPrevText = out.length > 1 ? am_text(newText, out[out.length - 2]) : '';
        const oldPrevText = oIdx >= 1 ? am_text(oldText, oldToks[oIdx - 1]) : '';
        const bpOk = newPrevText === oldPrevText;
        const oldStack = reconstructParens(oldToks, oldText, oIdx);
        if (o.td === 0 && templateStack.length === 0 && o.pd === parenHead.length && parenStacksEq(oldStack, parenHead) && am_lc(o) === lastClose && am_lb(o) === lastBang && bpOk && o.kid === t.kid && o.end === t.end - delta && am_nl(o) === t.nl && am_text(oldText, o) === newText.slice(t.off, t.end)) {
          ${adoptSuffix}
          return { toks: out, relexed };
        }
      }
    }
  }
  return { toks: out, relexed };
}
` : tplOnly ? `${findTokAtOff}
function windowRelexStep(oldText: string, oldToks: AlignMeta[], newText: string, start: number, end: number, ins: string): { toks: AlignMeta[]; relexed: number } {
  const delta = ins.length - (end - start);
  const editEnd = start + ins.length;
${tplAnchor}
  let scanOff = rb >= 0 ? oldToks[rb].end : 0;
  let pendingNl = false;
  let templateStack: number[] = [];
  const scratch: Tok[] = [];
  let relexed = 0;
  while (scanOff < newText.length) {
    const before = scratch.length;
    ({ pos: scanOff, pendingNl, templateStack } = lexFrom(newText, scanOff, pendingNl, templateStack, scratch, 1));
    if (scratch.length === before) break;
    const t = scratch[scratch.length - 1];
    out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, templateStack.length));
    relexed++;
    if (t.off >= editEnd) {
      const oIdx = findTokAtOff(oldToks, t.off - delta);
      if (oIdx >= 0) {
        const o = oldToks[oIdx];
        if (o.td === 0 && templateStack.length === 0 && o.kid === t.kid && o.end === t.end - delta && am_nl(o) === t.nl && am_text(oldText, o) === newText.slice(t.off, t.end)) {
          ${adoptSuffix}
          return { toks: out, relexed };
        }
      }
    }
  }
  return { toks: out, relexed };
}
` : `${findTokAtOff}
function windowRelexStep(oldText: string, oldToks: AlignMeta[], newText: string, start: number, end: number, ins: string): { toks: AlignMeta[]; relexed: number } {
  const delta = ins.length - (end - start);
  const editEnd = start + ins.length;
  let maxIdx = -1;
  for (let i = 0; i < oldToks.length; i++) {
    if (oldToks[i].end < start) maxIdx = i;
    else break;
  }
  const rb = maxIdx >= 0 ? maxIdx - 1 : -1;
  const out: AlignMeta[] = rb >= 0 ? oldToks.slice(0, rb + 1) : [];
  let scanOff = rb >= 0 ? oldToks[rb].end : 0;
  let pendingNl = false;
  const scratch: Tok[] = [];
  let relexed = 0;
  while (scanOff < newText.length) {
    const before = scratch.length;
    ({ pos: scanOff, pendingNl } = lexFrom(newText, scanOff, pendingNl, scratch, 1));
    if (scratch.length === before) break;
    const t = scratch[scratch.length - 1];
    out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, 0));
    relexed++;
    if (t.off >= editEnd) {
      const oIdx = findTokAtOff(oldToks, t.off - delta);
      if (oIdx >= 0) {
        const o = oldToks[oIdx];
        if (o.kid === t.kid && o.end === t.end - delta && am_nl(o) === t.nl && am_text(oldText, o) === newText.slice(t.off, t.end)) {
          ${adoptSuffix}
          return { toks: out, relexed };
        }
      }
    }
  }
  return { toks: out, relexed };
}
`) : '';
  const editBody = windowLex
    ? `      let curText = text;
      let curToks = oldToks;
      for (const e of edits) {
        const stepOldText = curText;
        const stepOldToks = curToks;
        const n = curText.length, start = Math.max(0, Math.min(e.start, n)), end = Math.max(start, Math.min(e.end, n));
        const ins = e.text;
        curText = curText.slice(0, start) + ins + curText.slice(end);
        const wr = windowRelexStep(stepOldText, stepOldToks, curText, start, end, ins);
        curToks = wr.toks;
        relexed += wr.relexed;
      }
      text = curText;
      prevToks = curToks;`
    : `      for (const e of edits) {
        const n = text.length, start = Math.max(0, Math.min(e.start, n)), end = Math.max(start, Math.min(e.end, n));
        text = text.slice(0, start) + e.text + text.slice(end);
      }
      prevToks = toMeta(lex(text));
      relexed = prevToks.length;`;
  const toMetaFn = hasNewline ? `
function scanMeta(src: string): AlignMeta[] {
  const toks: Tok[] = [];
  const meta: AlignMeta[] = [];
  let pos = 0, pendingNl = false, lineStart = true, emittedContent = false, flowDepth = 0;
  while (pos < src.length) {
    const before = toks.length;
    ({ pos, pendingNl, lineStart, emittedContent, flowDepth } = lexFrom(src, pos, pendingNl, lineStart, emittedContent, flowDepth, toks, 1));
    if (toks.length === before) break;
    const t = toks[toks.length - 1];
    meta.push(mk_align(t.off, t.end, t.kid, t.nl, flowDepth, 0, false, false, false, 0));
  }
  return meta;
}
const toMeta = (_toks: Tok[]): AlignMeta[] => { throw new Error('use scanMeta for newline'); };
` : rxOnly ? `
function scanMeta(src: string): AlignMeta[] {
  const toks: Tok[] = [];
  const meta: AlignMeta[] = [];
  let pos = 0, pendingNl = false;
  let prevLid = 0, prevKid = 0, bpLid = 0, hasPrev = false, hasPrev2 = false;
  let parenHead: boolean[] = [], lastClose = false, lastBang = false;
  while (pos < src.length) {
    const before = toks.length;
    ({ pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang } = lexFrom(src, pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, toks, 1));
    if (toks.length === before) break;
    const t = toks[toks.length - 1];
    meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, parenHead.length, lastClose, lastBang, t.lid === LID_LPAREN ? parenHead[parenHead.length - 1]! : false, 0));
  }
  return meta;
}
const toMeta = (_toks: Tok[]): AlignMeta[] => { throw new Error('use scanMeta for regex'); };
` : rxTpl ? `
function scanMeta(src: string): AlignMeta[] {
  const toks: Tok[] = [];
  const meta: AlignMeta[] = [];
  let pos = 0, pendingNl = false;
  let prevLid = 0, prevKid = 0, bpLid = 0, hasPrev = false, hasPrev2 = false;
  let parenHead: boolean[] = [], lastClose = false, lastBang = false;
  let templateStack: number[] = [];
  while (pos < src.length) {
    const before = toks.length;
    ({ pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack } = lexFrom(src, pos, pendingNl, prevLid, prevKid, hasPrev, bpLid, hasPrev2, parenHead, lastClose, lastBang, templateStack, toks, 1));
    if (toks.length === before) break;
    const t = toks[toks.length - 1];
    meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, parenHead.length, lastClose, lastBang, t.lid === LID_LPAREN ? parenHead[parenHead.length - 1]! : false, templateStack.length));
  }
  return meta;
}
const toMeta = (_toks: Tok[]): AlignMeta[] => { throw new Error('use scanMeta for rx+tpl'); };
` : tplOnly ? `
function scanMeta(src: string): AlignMeta[] {
  const toks: Tok[] = [];
  const meta: AlignMeta[] = [];
  let pos = 0, pendingNl = false;
  let templateStack: number[] = [];
  while (pos < src.length) {
    const before = toks.length;
    ({ pos, pendingNl, templateStack } = lexFrom(src, pos, pendingNl, templateStack, toks, 1));
    if (toks.length === before) break;
    const t = toks[toks.length - 1];
    meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, templateStack.length));
  }
  return meta;
}
const toMeta = (_toks: Tok[]): AlignMeta[] => { throw new Error('use scanMeta for tpl'); };
` : `const toMeta = (toks: Tok[]): AlignMeta[] => toks.map((t) => mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, 0));`;
  // Packed AlignMeta: full-field equality covers prior mode-specific checks
  // (unused state fields are always zeroed by scanMeta / toMeta / windowRelex).
  const checkStreamEqFn = (hasNewline || rxOnly || rxTpl || tplOnly) ? `
function checkStreamEq(text: string, meta: AlignMeta[]): boolean {
  const fresh = scanMeta(text);
  if (fresh.length !== meta.length) return false;
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i], t = meta[i];
    if (f.off !== t.off || f.end !== t.end || f.kid !== t.kid || f.pd !== t.pd || f.fd !== t.fd || f.flags !== t.flags || f.td !== t.td) return false;
    if (am_text(text, f) !== am_text(text, t)) return false;
  }
  return true;
}
` : `
function checkStreamEq(text: string, meta: AlignMeta[]): boolean {
  const fresh = toMeta(lex(text));
  if (fresh.length !== meta.length) return false;
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i], t = meta[i];
    if (f.off !== t.off || f.end !== t.end || f.kid !== t.kid || f.pd !== t.pd || f.fd !== t.fd || f.flags !== t.flags || f.td !== t.td) return false;
    if (am_text(text, f) !== am_text(text, t)) return false;
  }
  return true;
}
`;
  const initToks = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scanMeta(src)' : 'toMeta(lex(src))';
  // True fresh re-lex when window relex left a stale stream (unterminated → closed restore).
  const freshMeta = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scanMeta(text)' : 'toMeta(lex(text))';
  const reuseFns = topReuse ? `
function cstJSON(n: Cst): string {
  return JSON.stringify(n, (k, v) => (k === 'tokStart' || k === 'tokEnd' || k === 'ext' ? undefined : v));
}
function checkTreeEq(text: string, root: Node | null): boolean {
  try {
    const fresh = (_src = text, parse(lex(text)));
    if (root === null || fresh === null) return root === fresh;
    return cstJSON(root) === cstJSON(fresh as Cst);
  } catch { return root === null; }
}
function shiftSubtree(n: Cst, byteDelta: number, tokDelta: number): void {
  n.offset += byteDelta;
  n.end += byteDelta;
  n.tokStart += tokDelta;
  n.tokEnd += tokDelta;
  if ('ext' in n && typeof (n as Node).ext === 'number') (n as Node).ext! += tokDelta;
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
    const ndExt = nd.ext ?? nd.tokEnd;
    if (e.tokStart !== nd.tokStart) throw new Error('tok_start entry ' + i);
    if (e.tokEnd !== nd.tokEnd) throw new Error('tok_end entry ' + i);
    if (e.ext !== ndExt) throw new Error('ext entry ' + i);
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
    const tokStart = newEntries.length > 0 ? newEntries[0]!.tokStart : 0;
    const tokEnd = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.tokEnd : 0;
    return { root: { rule: oldRoot.rule, children, offset, end, tokStart, tokEnd }, entries: newEntries, reused: prefixKids.length + adopted.length };
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
    maxLook = 0;
    const sp = pos;
    const n = parseTopOne();
    if (n === null) { pos = sp; return null; }
    const ext = Math.max(n.tokEnd, maxLook);
    n.ext = ext;
    midMeta.push({ tokStart: n.tokStart, tokEnd: n.tokEnd, ext, off: n.offset, end: n.end, kidStart: 0, kidCount: 1 });
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
    const tokStart = newEntries.length > 0 ? newEntries[0]!.tokStart : 0;
    const tokEnd = newEntries.length > 0 ? newEntries[newEntries.length - 1]!.tokEnd : 0;
    return { root: { rule: oldRoot.rule, children, offset, end, tokStart, tokEnd }, segs: newSegs, entries: newEntries, reused: prefixSegs.length + adoptedSegs.length };
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
  return JSON.stringify(n, (k, v) => (k === 'tokStart' || k === 'tokEnd' || k === 'ext' ? undefined : v));
}
function checkTreeEq(text: string, root: Node | null): boolean {
  try {
    const fresh = (_src = text, parse(lex(text)));
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
        next = parse(toksFromMeta(text, prevToks)) as Node | null;
        if (next === null) { prevToks = ${freshMeta}; next = parse(toksFromMeta(text, prevToks)) as Node | null; }
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
        next = parse(toksFromMeta(text, prevToks)) as Node | null;
        if (next === null) { prevToks = ${freshMeta}; next = parse(toksFromMeta(text, prevToks)) as Node | null; nextSegs = next !== null ? _segs.slice() : []; }
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
      root = parse(toksFromMeta(text, prevToks)) as Node | null;
      if (root === null) { prevToks = ${freshMeta}; root = parse(toksFromMeta(text, prevToks)) as Node | null; }
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
    ? `  let root: Node | null = (_src = src, parse(lex(src))) as Node | null;
  segs = root !== null ? _segs.slice() : [];
  entries = root !== null ? _entries.slice() : [];`
    : shapeA
    ? `  let root: Node | null = (_src = src, parse(lex(src))) as Node | null;
  entries = root !== null ? _entries.slice() : [];`
    : `  let root: Node | null = (_src = src, parse(lex(src))) as Node | null;`;
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
${toMetaFn}
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
${checkStreamEqFn}${windowHelpers}${reuseFns}/** CST fast-path Doc (unchanged semantics). createDoc() without consumer builder dispatches here. */
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
        text = oldText;
        for (const e of edits) {
          const n = text.length, start = Math.max(0, Math.min(e.start, n)), end = Math.max(start, Math.min(e.end, n));
          text = text.slice(0, start) + e.text + text.slice(end);
        }
        try {
          prevToks = ${freshMeta};
          _src = text;
          root = parse(toksFromMeta(text, prevToks)) as Node | null;${shapeA || shapeB ? `
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

export const tsTarget: Target = {
  name: 'typescript',
  ext: 'ts',
  embedLexer(grammar: CstGrammar): string {
    return lexer(portableIR(grammar));
  },
  emitLexer(grammar: CstGrammar): string {
    return `// GENERATED by emit-portable.ts (tsTarget) — standalone TOKENIZER for grammar "${grammar.name ?? ''}".
// import { tokenize } from './this-file'; tokenize(src) → Tok[]. The same lexer is embedded in
// emitParser's output, so the parser's tokens are identical.
type Tok = { off: number; end: number; nl: boolean; kid: number; lid: number };
type RichTok = { kind: string; text: string; off: number; end: number; nl: boolean; kid: number; lid: number };

${lexer(portableIR(grammar))}

export function tokenize(src: string): RichTok[] {
  return lex(src).map((t) => ({ kind: tok_kind(t), text: tok_text(src, t), off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid }));
}
`;
  },
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ids = buildLexIdPlan(ir);
    const reuse = topReusePlan(ir);
    const ruleFns = ir.rules.map((r) => {
      if (r.kind === 'pratt') return prattRule(r, ir.tpl, ids);
      if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids);
      return rdRule(r, ids);
    }).join('\n\n');
    const matchTemplate = ir.tpl ? `function matchTemplate(): Cst | null {
  const t = peek();
  if (t === null || t.kid !== ${kidOf(ids, '$templateHead')}) return null;
  const children: Cst[] = [];
  const save = pos;
  children.push({ tokenType: '$templateHead', offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }); pos++;
  for (;;) {
    const expr = parse${ir.tpl.interpRule}();
    if (expr === null) { pos = save; return null; }
    children.push(expr);
    const next = peek();
    if (next === null) { pos = save; return null; }
    if (next.kid === ${kidOf(ids, '$templateMiddle')}) { children.push({ tokenType: '$templateMiddle', offset: next.off, end: next.end, tokStart: pos, tokEnd: pos + 1 }); pos++; continue; }
    if (next.kid === ${kidOf(ids, '$templateTail')}) { children.push({ tokenType: '$templateTail', offset: next.off, end: next.end, tokStart: pos, tokEnd: pos + 1 }); pos++; break; }
    pos = save; return null;
  }
  return { rule: '$template', children, offset: children[0].offset, end: children[children.length - 1].end, tokStart: save, tokEnd: pos };
}
` : '';
    return `// GENERATED by emit-portable.ts (tsTarget) — parser LIBRARY for grammar "${ir.grammarName}" (exports \`parse\`).
// The CLI runner (stdin → CST JSON) is a SEPARATE piece — tsTarget.emitRunner(), appended by the harness.

type Tok = { off: number; end: number; nl: boolean; kid: number; lid: number };
type RichTok = { kind: string; text: string; off: number; end: number; nl: boolean; kid: number; lid: number };
type Leaf = { tokenType: string; offset: number; end: number; tokStart: number; tokEnd: number };
type Node = { rule: string; children: Cst[]; offset: number; end: number; tokStart: number; tokEnd: number; ext?: number };
type Cst = Node | Leaf;

${lexerSrc ?? ''}

let toks: Tok[] = [];
let pos = 0;
let maxLook = 0;
let _capped = false;
let _suppressNext: Set<number> | null = null;
let _suppressCur: Set<number> | null = null;
let _src = '';
function peek(): Tok | null { maxLook = Math.max(maxLook, pos + 1); return pos < toks.length ? toks[pos] : null; }
function headLeafText(node: Cst): string {
  let n: Cst = node;
  while ('children' in n && n.children.length > 0) n = n.children[0];
  return _src.slice(n.offset, n.end);
}
function branch(rule: string, kids: Cst[], save: number): Node {
  const offset = kids.length > 0 ? kids[0].offset : (save < toks.length ? toks[save].off : 0);
  const end = kids.length > 0 ? kids[kids.length - 1].end : offset;
  return { rule, children: kids, offset, end, tokStart: save, tokEnd: pos };
}
function node(rule: string, kids: Cst[], fallbackOff: number = 0): Node {
  // Pratt LED path: tokStart is the leftmost operand's start (not the led trigger pos).
  const tokStart = kids.length ? kids[0].tokStart : pos;
  return { rule, children: kids, offset: kids.length ? kids[0].offset : fallbackOff, end: kids.length ? kids[kids.length - 1].end : fallbackOff, tokStart, tokEnd: pos };
}
function matchLit(lid: number, ttype: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.lid !== lid) return false;
  if (ttype !== '$punct') kids.push({ tokenType: ttype, offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }); pos++; return true;
}
function matchTok(kid: number, name: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.kid !== kid) return false;
  kids.push({ tokenType: name, offset: t.off, end: t.end, tokStart: pos, tokEnd: pos + 1 }); pos++; return true;
}
function callRule(fn: () => Node | null, kids: Cst[]): boolean {
  const n = fn();
  if (n === null) return false;
  kids.push(n); return true;
}
function star(once: () => boolean, kids: Cst[]): boolean {
  for (;;) { const sp = pos; const before = kids.length; if (!once()) { pos = sp; kids.length = before; break; } }
  return true;
}
function opt(body: () => boolean, kids: Cst[]): boolean {
  const sp = pos; const before = kids.length; if (!body()) { pos = sp; kids.length = before; } return true;
}
function sepBy(elem: () => boolean, delimLid: number, kids: Cst[]): boolean {
  if (!elem()) return true;   // the whole separated list is optional — zero elements is valid
  for (;;) {
    const sp = pos; const before = kids.length;
    if (!matchLit(delimLid, '$punct', kids)) { pos = sp; kids.length = before; break; }
    if (!elem()) break;   // a trailing delimiter is allowed — keep the pushed delim and stop
  }
  return true;
}
function altLit(opts: [number, string][], kids: Cst[]): boolean {
  for (const [lid, tt] of opts) if (matchLit(lid, tt, kids)) return true;
  return false;
}

${matchTemplate}${ruleFns}

// Library entry, in two composable phases. tokenize() lexes ONCE; pass its tokens to parse().
// Want both the token stream and the CST? Lex once: const t = tokenize(src); parse(t) — no
// re-lexing. Want only the CST? (_src = src, parse(lex(src))). (tokenize also records the source for
// head-leaf lookups.) No I/O — see emitRunner() for the stdin → JSON wrapper.
export function tokenize(src: string): RichTok[] {
  _src = src;
  return lex(src).map((t) => ({ kind: tok_kind(t), text: tok_text(src, t), off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid }));
}
export function parse(tokens: Tok[]): Cst | null {
  toks = tokens;
  pos = 0;
  maxLook = 0;
  const root = parse${ir.entry}();
  return root !== null && pos === toks.length ? root : null;
}

${(() => { const doc = docEditBlock(ir); return doc.code + '\n' + emitBuilderAddon(ir, ids, doc.parts); })()}
`;
  },
  emitRunner(): string {
    return `// CLI runner (harness only): stdin → CST JSON. Appended to the parser library by the gate;
// NOT part of the emitted parser. The import is hoisted, so it may follow the library code.
import { readFileSync } from 'node:fs';
const _raw = readFileSync(0, 'utf8');
const _editFast = process.argv.includes('edit-session-fast');
const _cstJSON = (n: Cst) => JSON.stringify(n, (k, v) => (k === 'tokStart' || k === 'tokEnd' || k === 'ext' ? undefined : v));
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
  const _root = (_src = _raw, parse(lex(_raw)));
  if (_root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  const kids = 'children' in _root ? _root.children : [];
  for (const k of kids) {
    const name = 'rule' in k ? k.rule : k.tokenType;
    process.stdout.write(name + '\\t' + k.tokStart + '\\t' + k.tokEnd + '\\n');
  }
  process.stdout.write('total\\t0\\t' + pos + '\\n');
} else {
  const _root = (_src = _raw, parse(lex(_raw)));
  if (_root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  process.stdout.write(_cstJSON(_root));
}
`;
  },
};
