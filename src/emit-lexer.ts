// Emit a SPECIALIZED tokenize() for a token-stream grammar — the lexer counterpart of
// emit-parser.ts. The data-driven createLexer dispatches per position over matcher
// lists, first-char filter objects and punct-literal groups; here all of that is baked
// at emit time into one `switch (charCode)` whose cases hold exactly the candidate
// regexes (declaration order) and a punct compare-chain (longest-first) for that char.
// Token regexes stay V8 regexes (measured at ~6% — the dispatch was the cost, not the
// matching); regex-vs-division context and paren-head tracking are baked to int-table
// loads on the token's interned k/t.
//
// Scope: grammars WITHOUT markup / indent / newline modes (those state machines stay
// interpreter-only for now) — emitLexer returns null for them and the caller falls back
// to importing createLexer. The emitted token stream is REQUIRED to be identical to
// createLexer's (same fields, same errors); test/emit-lexer-verify.ts gates it.
import type { CstGrammar, TokenDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import {
  tokenBlockPatternSource, tokenEscapeValidPatternSource, tokenPatternCharLoop,
  tokenPatternFirstCharSet, tokenPatternHasStartAnchor, tokenPatternSource,
} from './token-pattern.ts';

export interface LexerSymtab {
  typeKind: Map<string, number>;
  kwLitKind: Map<string, number>;
  puLitKind: Map<string, number>;
  KIND_PUNCT: number;
  KIND_NAMED_FALLBACK: number;
}

const J = (v: unknown) => JSON.stringify(v);

// The resync retract one-liner is emitted at two points in the relex loop (mid-loop and the
// post-loop EOF check); a single producer keeps the two from drifting (#45 B3).
const resyncRetractLine = (indent: string): string =>
  `${indent}if (wndHit >= 0) { tokN--; while (docLex.length > lexDiagBase && docLex[docLex.length - 1].offset >= tkOff[tokN]) docLex.length--; return wndHit; }`;

// The non-ASCII members of JS \s (the /u-free set), baked as a charCode test so a
// non-whitespace cc>127 (e.g. a Unicode identifier char) skips the LX_WS regex entirely. The
// regex `/\s+/y` matches at pos iff the lead char is \s, and ASCII \s is handled by the char
// loop, so `cc>127 && lxNonAsciiWs(cc)` is EXACTLY "the regex would match here" → byte-
// identical, minus the wasted exec on the common non-whitespace case (#45 B4).
const NON_ASCII_WS_FN =
  `function lxNonAsciiWs(cc: number) { return cc === 0xa0 || cc === 0x1680 || (cc >= 0x2000 && cc <= 0x200a) || cc === 0x2028 || cc === 0x2029 || cc === 0x202f || cc === 0x205f || cc === 0x3000 || cc === 0xfeff; }`;
// The non-ASCII whitespace fallback, emitted at the two sites that need it (after an ASCII run,
// and as the lead char). `cont` appends the `continue` the lead-char site needs.
const nonAsciiWsConsume = (v: string, cont: boolean, indent: string): string =>
  `${indent}if (${v} > 127 && lxNonAsciiWs(${v})) { LX_WS.lastIndex = pos; const m = LX_WS.exec(source); if (m !== null) { if (/[\\n\\r\\u2028\\u2029]/.test(m[0])) pendingNl = true; pos += m[0].length;${cont ? ' continue;' : ''} } }`;

export function emitSoaLexer(grammar: CstGrammar, st: LexerSymtab): string | null {
  // Out of scope: the markup / indentation / newline state machines.
  if (grammar.markup || grammar.indent || grammar.newline) return null;
  if (grammar.tokens.some(t => tokenBlockPatternSource(t) || t.blockOnly)) return null;

  const out: string[] = [];
  const emit = (s = '') => out.push(s);

  // ── Mirrors of createLexer's derived config (same sources, same order) ──
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  const punctLiterals = [...allLiterals].filter(l => !isKeywordLiteral(l)).sort((a, b) => b.length - a.length);
  const punctByFirstCc = new Map<number, string[]>();
  for (const lit of punctLiterals) {
    const cc = lit.charCodeAt(0);
    if (!punctByFirstCc.has(cc)) punctByFirstCc.set(cc, []);
    punctByFirstCc.get(cc)!.push(lit);
  }

  const identTokenName = grammar.tokens.find(t => t.identifier)?.name;
  const prefixedIdent = grammar.tokens
    .filter(t => t.identifierPrefix)
    .map(t => ({ name: t.name, prefix: t.identifierPrefix as string }));
  const identPrefixByName = new Map<string, string>(prefixedIdent.map(t => [t.name, t.prefix]));
  const identLike = new Set<string>([identTokenName, ...prefixedIdent.map(t => t.name)].filter(Boolean) as string[]);

  const templateToken = grammar.tokens.find(t => t.template);
  const tplOpen = templateToken?.template?.open ?? '';
  const tplInterpOpen = templateToken?.template?.interpOpen ?? '';
  const tplInterpClose = templateToken?.template?.interpClose ?? '';
  const tplBraceOpen = tplInterpOpen.slice(-1);
  const tplEscapeValid = templateToken ? tokenEscapeValidPatternSource(templateToken) : undefined;

  const regexCtx = grammar.tokens.find(t => t.regexContext)?.regexContext;
  const kOf = (name: string) => st.typeKind.get(name) ?? st.KIND_NAMED_FALLBACK;
  const tOf = (text: string) => (isKeywordLiteral(text) ? st.kwLitKind.get(text) : st.puLitKind.get(text)) ?? 0;
  let tSize = 1;
  for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
  for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
  const kSize = st.KIND_NAMED_FALLBACK + 1;

  // A 0/1 byte table over the t space (literal texts) or k space (token-type names).
  const litTable = (name: string, texts: Iterable<string>) => {
    const a = new Array<number>(tSize).fill(0);
    for (const x of texts) { const t = tOf(x); if (t > 0) a[t] = 1; }
    emit(`const ${name} = Uint8Array.from([${a.join(',')}]);`);
  };
  const typeTable = (name: string, types: Iterable<string>) => {
    const a = new Array<number>(kSize).fill(0);
    for (const x of types) a[kOf(x)] = 1;
    emit(`const ${name} = Uint8Array.from([${a.join(',')}]);`);
  };

  // The scan matchers (template token excluded — its state machine is below), in
  // declaration order, with their baked regexes and per-matcher facts.
  const matchers = grammar.tokens
    .filter(t => t.name !== templateToken?.name)
    .map((t, idx) => ({
      decl: t,
      name: t.name,
      re: `LXRE_${idx}_${t.name.replace(/[^A-Za-z0-9_]/g, '_')}`,
      pattern: tokenPatternSource(t),
      flags: tokenPatternHasStartAnchor(t) ? 'ym' : 'y',
      skip: t.flags.includes('skip'),
      isRegex: t.flags.includes('regex'),
      first: tokenPatternFirstCharSet(t),
      k: kOf(t.name),
      identLike: identLike.has(t.name),
      loop: tokenPatternCharLoop(t),
    }));

  emit(`// ── Emitted lexer (emit-lexer.ts): specialized tokenize for this grammar ──`);
  for (const m of matchers) emit(`const ${m.re} = new RegExp(${J(`(?:${m.pattern})`)}, ${J(m.flags)});`);
  emit(`const LX_WS = /\\s+/y;`);
  emit(NON_ASCII_WS_FN);
  emit(`// window-truncation retry: a matcher failing at the WINDOW edge is not a lex`);
  emit(`// error — the caller re-materializes a larger window (truncation cannot fake a`);
  emit(`// resync: suffix-zone equality makes a cut token's END mismatch the old one)`);
  emit(`const LEX_RETRY = { retry: true };`);
  emit(`let lexWindowMore = false;`);
  emit(`let lexSrcBase = 0;`);
  emit(`let lexDiagBase = 0;   // docLex floor for the current window (its own emissions sit above)`);
  emit(`// Shifted-resync support: lexResyncPd is the paren-depth delta between the live`);
  emit(`// stack and the old record at the adopted suffix's first token (the splice adds`);
  emit(`// it to every adopted tkPd, restoring true absolute depths). altSuffMin[j] =`);
  emit(`// min paren depth recorded over the old suffix [j, altN) (pop-on-empty = -1),`);
  emit(`// built lazily once per edit (the caller nulls it when the alt stream changes).`);
  emit(`let lexResyncPd = 0;`);
  emit(`let altSuffMin: Int32Array | null = null;`);
  emit(`let altSuffMinBuf: Int32Array | null = null;`);
  emit(`// ')' pops that found an empty stack, in THIS lexCore call's token indices`);
  emit(`let lexEmptyPops: number[] = [];`);
  emit(`// Min OLD-stream paren depth over the tokens inside the damage itself (set by the`);
  emit(`// caller before the window lex): the old-side trajectory min starts from here.`);
  emit(`let wndOldMin0 = 0x7fffffff;`);
  emit(`function buildAltSuffMin(lo: number) {`);
  emit(`  if (altSuffMinBuf === null || altSuffMinBuf.length < altN + 1) altSuffMinBuf = new Int32Array(altN + 1025);`);
  emit(`  altSuffMin = altSuffMinBuf;`);
  emit(`  altSuffMin![altN] = 0x7fffffff;`);
  emit(`  for (let j = altN - 1; j >= lo; j--) {`);
  emit(`    let d = altPd![j];`);
  emit(`    if (d === 0 && altK![j] === K_PUNCT && altT![j] === ${tOf(')')} && (j === 0 || altPd![j - 1] === 0)) d = -1;`);
  emit(`    const nx = altSuffMin![j + 1];`);
  emit(`    altSuffMin![j] = d < nx ? d : nx;`);
  emit(`  }`);
  emit(`}`);
  emit(`const LX_UNI_IDENT = /[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*/uy;`);
  emit(`const LX_UNI_CONT = /[$\\u200c\\u200d\\p{ID_Continue}]+/uy;`);
  emit(`const LX_UNI_FULL = /^[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*/u;`);
  emit(`const LX_DECODE_ESC = /\\\\u\\{([0-9a-fA-F]+)\\}|\\\\u([0-9a-fA-F]{4})/g;`);
  if (tplEscapeValid) emit(`const LX_TPL_ESC = new RegExp(${J(tplEscapeValid)}, 'y');`);
  // Regex-vs-division context tables (over interned k / t ints).
  litTable(`LX_PFXV`, regexCtx?.postfixAfterValueTexts ?? []);
  litTable(`LX_EXPRKW`, regexCtx?.regexAfterTexts ?? []);
  litTable(`LX_DIVT`, regexCtx?.divisionAfterTexts ?? []);
  typeTable(`LX_DIVK`, [...(regexCtx?.divisionAfterTypes ?? []), '$templateTail']);
  litTable(`LX_PARENKW`, regexCtx?.regexAfterParenKeywords ?? []);
  litTable(`LX_MEMBER`, regexCtx?.memberAccessTexts ?? []);
  const kwFirstCcs = new Set([...st.kwLitKind.keys()].map(k => k.charCodeAt(0)));
  const canBeKw = (first: { ascii: Set<number>; nonAscii: boolean } | null) =>
    !first || [...first.ascii].some(cc => kwFirstCcs.has(cc));   // keywords are ASCII-initial
  const kIdent = identTokenName ? kOf(identTokenName) : 0;
  const tRParen = tOf(')');
  const tLParen = tOf('(');
  emit(``);
  // ── Baked keyword recognizer over a SOURCE SPAN: t-intern with no slice and no hash.
  // Length window → first-charCode switch → per-keyword compare chains (shortest first);
  // returns exactly what LIT_KW.get(source.slice(a, b)) ?? 0 would — the keyword set is
  // enumerated completely and keywords are pure ASCII, so charCode compares are exact.
  emit(`function lexKwT(source: string, a: number, b: number) {`);
  const kwEntries = [...st.kwLitKind.entries()];
  if (kwEntries.length === 0) {
    emit(`  return 0;`);
  } else {
    const minKw = Math.min(...kwEntries.map(([k]) => k.length));
    const maxKw = Math.max(...kwEntries.map(([k]) => k.length));
    emit(`  const n = b - a;`);
    emit(`  if (n < ${minKw} || n > ${maxKw}) return 0;`);
    emit(`  switch (source.charCodeAt(a)) {`);
    const byC0 = new Map<number, Array<[string, number]>>();
    for (const e of kwEntries) {
      const c0 = e[0].charCodeAt(0);
      if (!byC0.has(c0)) byC0.set(c0, []);
      byC0.get(c0)!.push(e);
    }
    for (const [c0, entries] of [...byC0.entries()].sort((a, b) => a[0] - b[0])) {
      emit(`    case ${c0}: // ${entries.map(([k]) => k).join(' ')}`);
      for (const [text, t] of entries.sort((a, b) => a[0].length - b[0].length)) {
        const conds = [`n === ${text.length}`];
        for (let i = 1; i < text.length; i++) conds.push(`source.charCodeAt(a + ${i}) === ${text.charCodeAt(i)}`);
        emit(`      if (${conds.join(' && ')}) return ${t};`);
      }
      emit(`      return 0;`);
    }
    emit(`    default: return 0;`);
    emit(`  }`);
  }
  emit(`}`);
  // identTextValid, with the per-token prefix length baked at the call site.
  emit(`function lexIdentValid(text: string, prefixLen: number) {`);
  emit(`  const body = prefixLen > 0 ? text.slice(prefixLen) : text;`);
  emit(`  if (!body.includes('\\\\')) return true;`);
  emit(`  let bad = false;`);
  emit(`  const decoded = body.replace(LX_DECODE_ESC, (_m: string, braced: string, fixed: string) => {`);
  emit(`    const cp = parseInt(braced ?? fixed, 16);`);
  emit(`    if (cp > 0x10FFFF) { bad = true; return ''; }`);
  emit(`    return String.fromCodePoint(cp);`);
  emit(`  });`);
  emit(`  if (bad) return false;`);
  emit(`  const m = decoded.match(LX_UNI_FULL);`);
  emit(`  return m !== null && m[0].length === decoded.length;`);
  emit(`}`);
  if (templateToken) {
    emit(`function lexTplSpan(source: string, pos: number, validateEscapes: boolean) {`);
    emit(`  const tplFrom = pos;`);
    emit(`  while (pos < source.length) {`);
    emit(`    if (${startsWithExpr('source', 'pos', tplInterpOpen)}) return { endsWithInterp: true, end: pos + ${tplInterpOpen.length} };`);
    emit(`    if (source.charCodeAt(pos) === 92) {`);
    if (tplEscapeValid) {
      emit(`      if (validateEscapes) {`);
      emit(`        LX_TPL_ESC.lastIndex = pos;`);
      emit(`        const m = LX_TPL_ESC.exec(source);`);
      emit(`        if (!m) {`);
      emit(`          if (lexWindowMore) throw LEX_RETRY;`);
      emit(`          if (recovering) { docLex.push({ offset: pos + lexSrcBase, end: pos + lexSrcBase + 1, kind: 1, ch: '' }); pos += 1; continue; }`);
      emit(`          throw new Error('Invalid escape sequence in template at offset ' + pos);`);
      emit(`        }`);
      emit(`        pos += m[0].length;`);
      emit(`      } else { pos += 2; }`);
    } else {
      emit(`      pos += 2;`);
    }
    emit(`      continue;`);
    emit(`    }`);
    emit(`    if (${startsWithExpr('source', 'pos', tplOpen)}) return { endsWithInterp: false, end: pos + ${tplOpen.length} };`);
    emit(`    pos++;`);
    emit(`  }`);
    emit(`  if (lexWindowMore) throw LEX_RETRY;`);
    emit(`  if (recovering) {`);
    emit(`    docLex.push({ offset: tplFrom + lexSrcBase, end: source.length + lexSrcBase, kind: 2, ch: '' });`);
    emit(`    return { endsWithInterp: false, end: source.length };`);
    emit(`  }`);
    emit(`  throw new Error('Unterminated template literal at offset ' + pos);`);
    emit(`}`);
  }
  emit(``);
  // Tokens land in the parser runtime's column arrays (tkK/tkT/tkOff/tkEnd/tkFl + tokN)
  // — no per-token object, no text slice: text is materialized from the source span only
  // when a CST leaf is built. Flag bits: 1 = newlineBefore (the only stamp this emitted
  // lexer ever sets; comment/multilineFlow stamps belong to fallback-only grammars).
  emit(`function tokenize(source: string) {`);
  emit(`  docPieces = [source]; docPieceOff = [0]; docLen = source.length;`);
  emit(`  docFlat = source; docCur = 0;`);
  emit(`  tokN = 0;`);
  emit(`  parenCachePos = -1;`);
  emit(`  srcLenP1 = source.length + 1;`);
  emit(`  negFrom = 0x7fffffff;`);
  emit(`  lexCore(source, 0, -1, 0, -1, 0, 0);`);
  emit(`  return tokN;`);
  emit(`}`);
  // Verification of the WINDOWED path (issue #45 B2): emit-lexer-verify only exercises a FULL
  // lex (emit ≡ createLexer), and gen-lexer has no windowed counterpart to diff against — but the
  // windowed re-lex IS independently checked at the tree level. incremental-verify / exhaustive-
  // edits compare an edited parse (whose tokens come from this windowed re-lex) to a FRESH FULL
  // parse of the same text, byte-identical: a wrong windowed token would change the tree (or its
  // newlineBefore/commentBefore-driven shape) and fail there. So the oracle is the fresh full
  // parse, applied transitively through the parser.
  emit(`// The lexer core, parameterized for WINDOWED re-lexing: start at startPos with`);
  emit(`// the previous token's (k, t) as the regex-context seed (-1 = none / file start)`);
  emit(`// and EMPTY template/paren stacks (the caller restarts only at depth-0 safe`);
  emit(`// points). In window mode (wndPtr0 >= 0) the OLD stream sits in the alt buffers;`);
  emit(`// after each token pushed at/past wndMinOff, resync fires when it aligns with an`);
  emit(`// old token (same k/t, offsets shifted by wndDelta, both depth records 0) while`);
  emit(`// the window's own stacks are empty — returns that OLD index (the duplicate push`);
  emit(`// is retracted), or -1 when lexing ran to EOF.`);
  emit(`function lexCore(source: string, startPos: number, pvK: number, pvT: number, wndPtr0: number, wndMinOff: number, wndDelta: number, wndCs?: number, initParens?: boolean[] | null, srcBase?: number, hasMore?: boolean) {`);
  emit(`  if (srcBase === undefined) srcBase = 0;`);
  emit(`  lexWindowMore = hasMore === true;`);
  emit(`  lexSrcBase = srcBase;`);
  emit(`  const n = source.length;`);
  emit(`  let pos = startPos;`);
  emit(`  let pendingNl = false;`);
  emit(`  let extraFl = 0;`);
  emit(`  let lastBangWasPostfix = false;`);
  emit(`  let lastCloseWasParenHead = false;`);
  emit(`  const templateStack: number[] = [];`);
  emit(`  const parenHeadStack = initParens !== undefined && initParens !== null ? initParens : [];`);
  emit(`  let wndPtr = wndPtr0;`);
  emit(`  let wndHit = -1;`);
  emit(`  lexEmptyPops.length = 0;`);
  emit(`  // Trajectory minimums since the point the two lexes diverge (the damage start;`);
  emit(`  // before it, identical bytes from an identical anchor state give identical`);
  emit(`  // tokens and stack ops). An entry at depth <= BOTH mins was open at the`);
  emit(`  // divergence point in both lexes - i.e. it is the SAME entry.`);
  emit(`  let dmgMinOld = wndOldMin0, dmgMinNew = -1;`);
  emit(`  function tkPush(k: number, t: number, off: number, end: number) {`);
  emit(`    off += srcBase!; end += srcBase!;`);
  emit(`    if (tokN === tkCap) growTok();`);
  emit(`    tkK[tokN] = k; tkT[tokN] = t; tkOff[tokN] = off; tkEnd[tokN] = end;`);
  emit(`    tkFl[tokN] = (pendingNl ? 1 : 0) | extraFl;`);
  emit(`    extraFl = 0;`);
  emit(`    tkDp[tokN] = templateStack.length;`);
  emit(`    tkPd[tokN] = parenHeadStack.length;`);
  emit(`    pendingNl = false;`);
  emit(`    pvK = k; pvT = t;`);
  emit(`    tokN++;`);
  emit(`    // Resync: adopt the OLD suffix from this aligned token on. Sound iff the old`);
  emit(`    // suffix's lexing is reproducible from OBSERVABLE state alone. Always required:`);
  emit(`    //  - both template stacks EMPTY (an entry's brace counter is mutable state no`);
  emit(`    //    record captures - depth equality cannot prove counters equal);`);
  emit(`    //  - the candidate carries no cross-token flag its adopted successor reads`);
  emit(`    //    (postfix-ambiguous op / control keyword / '(' / ')' each make the NEXT`);
  emit(`    //    token's lexing depend on tokens BEFORE the candidate, which the window`);
  emit(`    //    may have re-derived differently than the old stream had them).`);
  emit(`    // Then either of two sufficient paren-stack conditions:`);
  emit(`    //  - FAST: equal depth, never dipped below it since the divergence point on`);
  emit(`    //    either side - every open entry is then pre-divergence-common, the stacks`);
  emit(`    //    are content-EQUAL, and all future pops behave identically; or`);
  emit(`    //  - SHIFTED: the old suffix never pops an entry that is open at the candidate`);
  emit(`    //    (suffix min depth >= candidate depth, a pop-on-empty counted as -1): no`);
  emit(`    //    open entry's head-ness is ever read again, so the contents are irrelevant`);
  emit(`    //    and the depths may differ by an arbitrary shift - the caller re-bases the`);
  emit(`    //    adopted tkPd column by lexResyncPd to the new truth.`);
  emit(`    if (wndPtr >= 0) {`);
  emit(`      const pd = tkPd[tokN - 1];`);
  emit(`      if (dmgMinNew < 0) { if (off >= wndCs!) dmgMinNew = pd; }`);
  emit(`      else if (pd < dmgMinNew) dmgMinNew = pd;`);
  emit(`      if (off >= wndMinOff) {`);
  emit(`        while (wndPtr < altN && (altOff![wndPtr] < 0 ? altOff![wndPtr] + srcLenP1 : altOff![wndPtr]) + wndDelta < off) { if (altPd![wndPtr] < dmgMinOld) dmgMinOld = altPd![wndPtr]; wndPtr++; }`);
  emit(`        if (wndPtr < altN && (altOff![wndPtr] < 0 ? altOff![wndPtr] + srcLenP1 : altOff![wndPtr]) + wndDelta === off && altK![wndPtr] === k && altT![wndPtr] === t`);
  emit(`            && (altEnd![wndPtr] < 0 ? altEnd![wndPtr] + srcLenP1 : altEnd![wndPtr]) + wndDelta === end`);
  emit(`            // the candidate's LEADING-TRIVIA flags must match too: the gap before`);
  emit(`            // it may sit inside the edit (newline removed/added without moving any`);
  emit(`            // token bytes), and parsers read these flags (sameLine / commentBefore)`);
  emit(`            && altFl![wndPtr] === tkFl[tokN - 1]`);
  emit(`            && templateStack.length === 0 && altDp![wndPtr] === 0`);
  emit(`            && LX_PFXV[t] === 0 && LX_PARENKW[t] === 0`);
  emit(`            && !(k === K_PUNCT && (t === ${tLParen} || t === ${tRParen}))) {`);
  emit(`          const q = altPd![wndPtr];`);
  emit(`          if (q < dmgMinOld) dmgMinOld = q;`);
  emit(`          if (q === pd && pd <= dmgMinOld && pd <= dmgMinNew) {`);
  emit(`            wndHit = wndPtr;`);
  emit(`            lexResyncPd = 0;`);
  emit(`          } else {`);
  emit(`            // shifted: q = 0 needs only "no pop-on-empty beyond the candidate"`);
  emit(`            // (the doc-level list is ascending - one end check); q > 0 needs the`);
  emit(`            // full suffix minimum, built lazily once per edit`);
  emit(`            let okTail;`);
  emit(`            if (q === 0) {`);
  emit(`              okTail = docEmptyPops.length === 0 || docEmptyPops[docEmptyPops.length - 1] <= wndPtr;`);
  emit(`            } else {`);
  emit(`              if (altSuffMin === null) buildAltSuffMin(wndPtr0);`);
  emit(`              okTail = altSuffMin![wndPtr + 1] >= q;`);
  emit(`            }`);
  emit(`            if (okTail) {`);
  emit(`              wndHit = wndPtr;`);
  emit(`              lexResyncPd = pd - q;`);
  emit(`            }`);
  emit(`          }`);
  emit(`        }`);
  emit(`      }`);
  emit(`    }`);
  emit(`  }`);
  emit(`  // prevIsValue, baked: postfix-ambiguous op → its recorded position; an expression-`);
  emit(`  // head keyword or a control-head ')' is NOT a value; else division-prev type/text.`);
  emit(`  function prevIsValue() {`);
  emit(`    const k = tokN > 0 ? tkK[tokN - 1] : pvK;`);
  emit(`    if (k < 0) return false;`);
  emit(`    const t = tokN > 0 ? tkT[tokN - 1] : pvT;`);
  emit(`    if (LX_PFXV[t] !== 0) return lastBangWasPostfix;`);
  emit(`    if (k === ${kIdent} && LX_EXPRKW[t] !== 0) return false;`);
  emit(`    if (t === ${tRParen} && lastCloseWasParenHead) return false;`);
  emit(`    return LX_DIVK[k] !== 0 || LX_DIVT[t] !== 0;`);
  emit(`  }`);
  emit(`  while (pos < n) {`);
  emit(`    // resync retracts the duplicated token push — and any lexer diagnostics
    // emitted FOR it (the old stream's persisted entry survives via the shift;
    // keeping the window's copy too double-reports the same character)`);
  emit(resyncRetractLine('    '));
  emit(`    const cc = source.charCodeAt(pos);`);
  emit(`    // whitespace: ASCII \\s run by char loop; a non-ASCII candidate falls back to the regex`);
  emit(`    if (cc === 32 || (cc >= 9 && cc <= 13)) {`);
  emit(`      let wc = cc;`);
  emit(`      do {`);
  emit(`        if (wc === 10 || wc === 13) pendingNl = true;`);   // JS line terminators LF/CR (LS/PS via the \\s regex below)
  emit(`        pos++;`);
  emit(`        wc = source.charCodeAt(pos);`);
  emit(`      } while (wc === 32 || (wc >= 9 && wc <= 13));`);
  emit(`${nonAsciiWsConsume('wc', false, '      ')}`);
  emit(`      continue;`);
  emit(`    }`);
  emit(`${nonAsciiWsConsume('cc', true, '    ')}`);
  if (templateToken) {
    const tplCloseT = kwFirstCcs.has(tplInterpClose.charCodeAt(0)) ? 'lexKwT(source, startPos, r.end)' : '0';
    const tplOpenT = kwFirstCcs.has(tplOpen.charCodeAt(0)) ? 'lexKwT(source, startPos, r.end)' : '0';
    emit(`    if (templateStack.length > 0) {`);
    emit(`      if (${startsWithExpr('source', 'pos', tplInterpClose, 'cc')}) {`);
    emit(`        const depth = templateStack[templateStack.length - 1];`);
    emit(`        if (depth === 0) {`);
    emit(`          templateStack.pop();`);
    emit(`          const startPos = pos;`);
    emit(`          const r = lexTplSpan(source, pos + ${tplInterpClose.length}, false);`);
    emit(`          if (r.endsWithInterp) {`);
    emit(`            tkPush(${kOf('$templateMiddle')}, ${tplCloseT}, startPos, r.end);`);
    emit(`            templateStack.push(0);`);
    emit(`          } else {`);
    emit(`            tkPush(${kOf('$templateTail')}, ${tplCloseT}, startPos, r.end);`);
    emit(`          }`);
    emit(`          pos = r.end;`);
    emit(`          continue;`);
    emit(`        }`);
    emit(`        templateStack[templateStack.length - 1] = depth - 1;`);
    emit(`      } else if (cc === ${tplBraceOpen.charCodeAt(0)}) {`);
    emit(`        templateStack[templateStack.length - 1]++;`);
    emit(`      }`);
    emit(`    }`);
    emit(`    if (${startsWithExpr('source', 'pos', tplOpen, 'cc')}) {`);
    emit(`      const tagged = prevIsValue();`);
    emit(`      const startPos = pos;`);
    emit(`      const r = lexTplSpan(source, pos + ${tplOpen.length}, !tagged);`);
    emit(`      if (r.endsWithInterp) {`);
    emit(`        tkPush(${kOf('$templateHead')}, ${tplOpenT}, startPos, r.end);`);
    emit(`        templateStack.push(0);`);
    emit(`      } else {`);
    emit(`        tkPush(${kOf(templateToken.name)}, ${tplOpenT}, startPos, r.end);`);
    emit(`      }`);
    emit(`      pos = r.end;`);
    emit(`      continue;`);
    emit(`    }`);
  }

  // ── The per-charCode dispatch switch: matcher candidates (declaration order) then
  // the punct compare-chain, identical action lists clustered into one case group. ──
  const admits = (m: (typeof matchers)[number], cc: number) => !m.first || m.first.ascii.has(cc);
  const actionsOf = (cc: number) => ({
    ms: matchers.filter(m => admits(m, cc)),
    ps: punctByFirstCc.get(cc) ?? [],
  });
  // The char-loop fast path may replace the regex try only when the loop-shaped matcher
  // is FIRST in declaration order for this cc (so no earlier matcher is skipped) and the
  // cc enters via the plain head class. skip/isRegex keep the regex path (pendingNl scan
  // / prevIsValue guard live there).
  const fastOf = (cc: number, ms: (typeof matchers)[number][]) =>
    ms.length > 0 && ms[0].loop !== null && !ms[0].skip && !ms[0].isRegex && ms[0].loop.first.includes(cc);
  const groups = new Map<string, { ccs: number[]; ms: (typeof matchers)[number][]; ps: string[]; fast: boolean }>();
  for (let cc = 0; cc < 128; cc++) {
    const { ms, ps } = actionsOf(cc);
    if (ms.length === 0 && ps.length === 0) continue;
    const fast = fastOf(cc, ms);
    const sig = ms.map(m => m.name).join(',') + '|' + ps.join(',') + (fast ? '|F' : '');
    if (!groups.has(sig)) groups.set(sig, { ccs: [], ms, ps, fast });
    groups.get(sig)!.ccs.push(cc);
  }
  // Matchers with NO provable first-char set must also run for cc > 127 / unlisted cc.
  const alwaysMatchers = matchers.filter(m => !m.first);
  const nonAsciiMatchers = matchers.filter(m => m.first && m.first.nonAscii);

  const emitMatcherTry = (m: (typeof matchers)[number], ind: string) => {
    emit(`${ind}${m.re}.lastIndex = pos;`);
    emit(`${ind}{ const m = ${m.re}.exec(source);`);
    emit(`${ind}  if (m !== null) {`);
    if (m.identLike) {
      const plen = (identPrefixByName.get(m.name) ?? '').length;
      emit(`${ind}    if (!lexIdentValid(m[0], ${plen})) {`);
      emit(`${ind}      if (lexWindowMore) throw LEX_RETRY;`);
      emit(`${ind}      if (!recovering) throw new Error("Invalid identifier escape at offset " + pos + ": '" + m[0] + "'");`);
      emit(`${ind}      docLex.push({ offset: pos + lexSrcBase, end: pos + lexSrcBase + m[0].length, kind: 3, ch: m[0] });`);
      emit(`${ind}    }`);
    }
    if (m.skip) {
      emit(`${ind}    if (/[\\n\\r\\u2028\\u2029]/.test(m[0])) pendingNl = true;`);
      emit(`${ind}    pos += m[0].length;`);
    } else {
      emit(`${ind}    const _e = pos + m[0].length;`);
      emit(`${ind}    tkPush(${m.k}, ${canBeKw(m.first) ? 'lexKwT(source, pos, _e)' : '0'}, pos, _e);`);
      emit(`${ind}    pos = _e;`);
    }
    emit(`${ind}    continue;`);
    emit(`${ind}  } }`);
  };
  const emitPunct = (lit: string, ind: string) => {
    // Chars 1..len-1 already known to match when this leaf is reached via the chain below.
    if (lit === '(') {
      emit(`${ind}{ const isMemberName = tokN >= 2 && LX_MEMBER[tkT[tokN - 2]] !== 0;`);
      emit(`${ind}  const _ph = !isMemberName && tokN >= 1 && tkK[tokN - 1] === ${kIdent} && LX_PARENKW[tkT[tokN - 1]] !== 0;`);
      emit(`${ind}  parenHeadStack.push(_ph);`);
      emit(`${ind}  extraFl = _ph ? 8 : 0; }`);
    } else if (lit === ')') {
      emit(`${ind}if (parenHeadStack.length === 0) { lastCloseWasParenHead = false; lexEmptyPops.push(tokN); }`);
      emit(`${ind}else lastCloseWasParenHead = parenHeadStack.pop()!;`);
    }
    if (regexCtx?.postfixAfterValueTexts?.includes(lit)) {
      emit(`${ind}lastBangWasPostfix = prevIsValue();`);
    }
    emit(`${ind}tkPush(K_PUNCT, ${tOf(lit)}, pos, pos + ${lit.length});`);
    emit(`${ind}pos += ${lit.length};`);
    emit(`${ind}continue;`);
  };
  const emitPunctChain = (ps: string[], ind: string) => {
    // Longest-first (the group is pre-sorted): each literal = a charCode compare chain
    // over chars 1..len-1 (char 0 is the case label).
    for (const lit of ps) {
      const conds = [];
      for (let i = 1; i < lit.length; i++) conds.push(`source.charCodeAt(pos + ${i}) === ${lit.charCodeAt(i)}`);
      if (conds.length > 0) {
        emit(`${ind}if (${conds.join(' && ')}) {`);
        emitPunct(lit, ind + '  ');
        emit(`${ind}}`);
      } else {
        emitPunct(lit, ind);
      }
    }
  };

  // Range-condensed charCode condition over a sorted ASCII code list, hottest-first
  // (descending range start puts lowercase before uppercase before digits).
  const ccCond = (v: string, codes: number[]) => {
    const rs: Array<[number, number]> = [];
    for (const c of codes) {
      if (rs.length > 0 && rs[rs.length - 1][1] === c - 1) rs[rs.length - 1][1] = c;
      else rs.push([c, c]);
    }
    rs.sort((a, b) => b[0] - a[0]);
    return rs.map(([a, b]) => (a === b ? `${v} === ${a}` : `(${v} >= ${a} && ${v} <= ${b})`)).join(' || ');
  };

  emit(`    switch (cc) {`);
  for (const g of groups.values()) {
    emit(`      ${g.ccs.map(c => `case ${c}:`).join(' ')} {`);
    if (g.fast) {
      // Char-loop fast path: consume the plain continuation class; a bail stop char
      // (escape opener) falls through to the regex try below, which re-scans from pos.
      const lp = g.ms[0].loop!;
      const bails = lp.bail.map(c => `c === ${c}`);
      if (lp.bailNonAscii) bails.push(`c > 127`);
      emit(`        let p = pos + 1;`);
      emit(`        let c = source.charCodeAt(p);`);
      emit(`        while (${ccCond('c', lp.cont)}) { p++; c = source.charCodeAt(p); }`);
      emit(`        if (${bails.length > 0 ? `!(${bails.join(' || ')})` : 'true'}) {`);
      emit(`          tkPush(${g.ms[0].k}, ${canBeKw(g.ms[0].first) ? 'lexKwT(source, pos, p)' : '0'}, pos, p);`);
      emit(`          pos = p;`);
      emit(`          continue;`);
      emit(`        }`);
    }
    for (const m of g.ms) {
      if (m.isRegex) {
        emit(`        if (!prevIsValue()) {`);
        emitMatcherTry(m, '        ');
        emit(`        }`);
      } else {
        emitMatcherTry(m, '        ');
      }
    }
    emitPunctChain(g.ps, '        ');
    emit(`        break;`);
    emit(`      }`);
  }
  emit(`      default: {`);
  for (const m of [...alwaysMatchers, ...nonAsciiMatchers]) {
    // Faithful to the filter semantics: a null-filter matcher runs everywhere; a
    // nonAscii-admitting matcher runs for cc > 127. (Listed ASCII ccs took their case.)
    if (m.first && m.first.nonAscii) {
      emit(`        if (cc > 127) {`);
      emitMatcherTry(m, '        ');
      emit(`        }`);
    } else {
      emitMatcherTry(m, '        ');
    }
  }
  emit(`        break;`);
  emit(`      }`);
  emit(`    }`);
  // Shared tail: identifier extension → Unicode identifier fallback → prefixed → error.
  if (identLike.size > 0) {
    emit(`    if (tokN > 0) {`);
    emit(`      const _li = tokN - 1;`);
    const likeKs = [...identLike].map(kOf);
    const likeCond = likeKs.map(k => `tkK[_li] === ${k}`).join(' || ');
    emit(`      if ((${likeCond}) && tkEnd[_li] === pos + srcBase) {`);
    emit(`        LX_UNI_CONT.lastIndex = pos;`);
    emit(`        const cont = LX_UNI_CONT.exec(source);`);
    emit(`        if (cont !== null) {`);
    emit(`          pos += cont[0].length;`);
    emit(`          tkEnd[_li] = pos + srcBase;`);
    emit(`          tkT[_li] = lexKwT(source, tkOff[_li] - srcBase, pos);`);
    emit(`          continue;`);
    emit(`        }`);
    emit(`      }`);
    emit(`    }`);
  }
  if (identTokenName) {
    emit(`    LX_UNI_IDENT.lastIndex = pos;`);
    emit(`    { const im = LX_UNI_IDENT.exec(source);`);
    emit(`      if (im !== null) {`);
    emit(`        const _e = pos + im[0].length;`);
    emit(`        tkPush(${kOf(identTokenName)}, lexKwT(source, pos, _e), pos, _e);`);
    emit(`        pos = _e;`);
    emit(`        continue;`);
    emit(`      } }`);
  }
  for (const pt of prefixedIdent) {
    emit(`    if (${startsWithExpr('source', 'pos', pt.prefix)}) {`);
    emit(`      LX_UNI_IDENT.lastIndex = pos + ${pt.prefix.length};`);
    emit(`      const pm = LX_UNI_IDENT.exec(source);`);
    emit(`      if (pm !== null) {`);
    emit(`        const _e = pos + ${pt.prefix.length} + pm[0].length;`);
    emit(`        tkPush(${kOf(pt.name)}, ${kwFirstCcs.has(pt.prefix.charCodeAt(0)) ? 'lexKwT(source, pos, _e)' : '0'}, pos, _e);`);
    emit(`        pos = _e;`);
    emit(`        continue;`);
    emit(`      }`);
    emit(`    }`);
  }
  emit(`    if (lexWindowMore) throw LEX_RETRY;`);
  emit(`    if (recovering) {`);
  emit(`      docLex.push({ offset: pos + srcBase, end: pos + srcBase + 1, kind: 0, ch: source[pos] });`);
  emit(`      tkPush(${st.KIND_NAMED_FALLBACK}, 0, pos, pos + 1);`);
  emit(`      pos += 1;`);
  emit(`      continue;`);
  emit(`    }`);
  emit(`    throw new Error("Unexpected character at offset " + pos + ": '" + source[pos] + "'");`);
  emit(`  }`);
  emit(resyncRetractLine('  '));
  emit(`  return hasMore ? -2 : -1;`);
  emit(`}`);
  emit(`// Windowed-relex restart anchor: the last token B ending at/before the damage`);
  emit(`// whose recorded stack depths are zero and whose shape leaves no cross-token`);
  emit(`// lexer flag live (a control-head ')' or a postfix-ambiguous operator would`);
  emit(`// make the next token's regex-context depend on unrecoverable state). -1 = file`);
  emit(`// head (always sound, degrades to a full re-lex).`);
  emit(`function findRestart(cs: number) {`);
  emit(`  let lo = 0, hi = tokN;`);
  // STRICTLY before the damage: a token ENDING exactly at cs can be EXTENDED by
  // the edit under maximal munch ('b' + inserted 'x' = 'bx'; '=' + '=' = '==';
  // deleting the gap glues neighbours) and the anchor itself is never re-lexed —
  // with < the abutting token falls inside the window and the merge is re-derived.
  emit(`  while (lo < hi) { const mid = (lo + hi) >> 1; if (tend(mid) < cs) lo = mid + 1; else hi = mid; }`);
  emit(`  for (let b = lo - 1; b >= 0; b--) {`);
  emit(`    // template depth must be zero (interp brace counters are not reconstructable),`);
  emit(`    // and the anchor token must leave no cross-token lexer flag live: not a`);
  emit(`    // control-head ')', not a postfix-ambiguous op, and not a control KEYWORD`);
  emit(`    // (a '(' lexed first in the window would mis-derive its head-ness from a`);
  emit(`    // missing predecessor). Paren depth may be anything — the live stack is`);
  emit(`    // reconstructed from the recorded depths and the '(' head bits.`);
  emit(`    if (tkDp[b] === 0 && LX_PFXV[tkT[b]] === 0 && LX_PARENKW[tkT[b]] === 0 && !(tkK[b] === 1 && tkT[b] === ${tRParen})) return b;`);
  emit(`  }`);
  emit(`  return -1;`);
  emit(`}`);
  emit(`// Rebuild the live paren-head stack enclosing token b: scanning backward, the`);
  emit(`// first '(' recording exactly depth d is the live opener of level d (closed`);
  emit(`// openers at that depth are re-opened later, and the re-opener comes first`);
  emit(`// backward). The '(' records its depth INCLUDING itself, and carries its`);
  emit(`// control-head-ness as tkFl bit 8.`);
  emit(`function reconstructParens(b: number) {`);
  emit(`  let need = b >= 0 ? tkPd[b] : 0;`);
  emit(`  const out: boolean[] = new Array(need);`);
  emit(`  for (let i = b; i >= 0 && need > 0; i--) {`);
  emit(`    if (tkK[i] === 1 && tkT[i] === ${tOf('(')} && tkPd[i] === need) { out[need - 1] = (tkFl[i] & 8) !== 0; need--; }`);
  emit(`  }`);
  emit(`  return out;`);
  emit(`}`);
  emit(`// Session cache for the live paren stack: the previous edit's anchor stack rolled`);
  emit(`// FORWARD over the tokens between the two anchors (push on '(', pop on ')') — the`);
  emit(`// backward scan is O(distance to the outermost live opener), which a deep`);
  emit(`// stationary session would pay per keystroke. Tokens at/before the cached anchor`);
  emit(`// are splice-stable (every splice begins past its own anchor), so the baseline`);
  emit(`// stays exact; a backward jump (b < cached) falls back to the full scan.`);
  emit(`let parenCachePos = -1;`);
  emit(`let parenCacheStack: boolean[] = [];`);
  emit(`function reconstructParensCached(b: number) {`);
  emit(`  let stack: boolean[];`);
  emit(`  if (b < 0) stack = [];`);
  emit(`  else if (parenCachePos >= 0 && parenCachePos <= b) {`);
  emit(`    stack = parenCacheStack;`);
  emit(`    for (let i = parenCachePos + 1; i <= b; i++) {`);
  emit(`      if (tkK[i] === 1) {`);
  emit(`        if (tkT[i] === ${tOf('(')}) stack.push((tkFl[i] & 8) !== 0);`);
  emit(`        else if (tkT[i] === ${tRParen}) { if (stack.length > 0) stack.pop(); }`);
  emit(`      }`);
  emit(`    }`);
  emit(`  } else stack = reconstructParens(b);`);
  emit(`  parenCachePos = b; parenCacheStack = stack;`);
  emit(`  return stack.slice();`);
  emit(`}`);
  return out.join('\n');
}

// A baked `source.startsWith(lit, pos)` as charCode compares; `cc0Var` names a variable
// already holding charCodeAt(pos) (so char 0 reuses it).
function startsWithExpr(src: string, posVar: string, lit: string, cc0Var?: string): string {
  const parts: string[] = [];
  for (let i = 0; i < lit.length; i++) {
    const lhs = i === 0 && cc0Var ? cc0Var : `${src}.charCodeAt(${posVar}${i === 0 ? '' : ` + ${i}`})`;
    parts.push(`${lhs} === ${lit.charCodeAt(i)}`);
  }
  return parts.join(' && ');
}
