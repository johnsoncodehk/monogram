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
  tokenBlockPatternSource, tokenEscapeValidPatternSource, tokenPatternFirstCharSet,
  tokenPatternHasStartAnchor, tokenPatternSource,
} from './token-pattern.ts';

export interface LexerSymtab {
  typeKind: Map<string, number>;
  kwLitKind: Map<string, number>;
  puLitKind: Map<string, number>;
  KIND_PUNCT: number;
  KIND_NAMED_FALLBACK: number;
}

const J = (v: unknown) => JSON.stringify(v);

export function emitLexer(grammar: CstGrammar, st: LexerSymtab): string | null {
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
    }));

  emit(`// ── Emitted lexer (emit-lexer.ts): specialized tokenize for this grammar ──`);
  for (const m of matchers) emit(`const ${m.re} = new RegExp(${J(`(?:${m.pattern})`)}, ${J(m.flags)});`);
  emit(`const LX_WS = /\\s+/y;`);
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
  emit(``);
  emit(`function lexMk(type, text, offset, k) {`);
  emit(`  return { type, text, offset, k, t: LIT_KW.get(text) ?? 0, newlineBefore: false, commentBefore: false, multilineFlowBefore: false };`);
  emit(`}`);
  // For tokens whose text provably can't be a keyword (first char outside every
  // keyword's first char): the kw int is 0 by construction — no lookup.
  emit(`function lexMk0(type, text, offset, k) {`);
  emit(`  return { type, text, offset, k, t: 0, newlineBefore: false, commentBefore: false, multilineFlowBefore: false };`);
  emit(`}`);
  emit(`function lexMkPu(text, offset, t) {`);
  emit(`  return { type: '', text, offset, k: K_PUNCT, t, newlineBefore: false, commentBefore: false, multilineFlowBefore: false };`);
  emit(`}`);
  // identTextValid, with the per-token prefix length baked at the call site.
  emit(`function lexIdentValid(text, prefixLen) {`);
  emit(`  const body = prefixLen > 0 ? text.slice(prefixLen) : text;`);
  emit(`  if (!body.includes('\\\\')) return true;`);
  emit(`  let bad = false;`);
  emit(`  const decoded = body.replace(LX_DECODE_ESC, (_m, braced, fixed) => {`);
  emit(`    const cp = parseInt(braced ?? fixed, 16);`);
  emit(`    if (cp > 0x10FFFF) { bad = true; return ''; }`);
  emit(`    return String.fromCodePoint(cp);`);
  emit(`  });`);
  emit(`  if (bad) return false;`);
  emit(`  const m = decoded.match(LX_UNI_FULL);`);
  emit(`  return m !== null && m[0].length === decoded.length;`);
  emit(`}`);
  if (templateToken) {
    emit(`function lexTplSpan(source, pos, validateEscapes) {`);
    emit(`  while (pos < source.length) {`);
    emit(`    if (${startsWithExpr('source', 'pos', tplInterpOpen)}) return { endsWithInterp: true, end: pos + ${tplInterpOpen.length} };`);
    emit(`    if (source.charCodeAt(pos) === 92) {`);
    if (tplEscapeValid) {
      emit(`      if (validateEscapes) {`);
      emit(`        LX_TPL_ESC.lastIndex = pos;`);
      emit(`        const m = LX_TPL_ESC.exec(source);`);
      emit(`        if (!m) throw new Error('Invalid escape sequence in template at offset ' + pos);`);
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
    emit(`  throw new Error('Unterminated template literal at offset ' + pos);`);
    emit(`}`);
  }
  emit(``);
  emit(`function tokenize(source) {`);
  emit(`  const tokens = [];`);
  emit(`  const n = source.length;`);
  emit(`  let pos = 0;`);
  emit(`  let pendingNl = false;`);
  emit(`  let lastBangWasPostfix = false;`);
  emit(`  let lastCloseWasParenHead = false;`);
  emit(`  const templateStack = [];`);
  emit(`  const parenHeadStack = [];`);
  emit(`  function push(t) {`);
  emit(`    if (pendingNl) { t.newlineBefore = true; pendingNl = false; }`);
  emit(`    tokens.push(t);`);
  emit(`  }`);
  emit(`  // prevIsValue, baked: postfix-ambiguous op → its recorded position; an expression-`);
  emit(`  // head keyword or a control-head ')' is NOT a value; else division-prev type/text.`);
  emit(`  function prevIsValue(prev) {`);
  emit(`    if (prev === undefined) return false;`);
  emit(`    if (LX_PFXV[prev.t] !== 0) return lastBangWasPostfix;`);
  emit(`    if (prev.k === ${kIdent} && LX_EXPRKW[prev.t] !== 0) return false;`);
  emit(`    if (prev.t === ${tRParen} && lastCloseWasParenHead) return false;`);
  emit(`    return LX_DIVK[prev.k] !== 0 || LX_DIVT[prev.t] !== 0;`);
  emit(`  }`);
  emit(`  while (pos < n) {`);
  emit(`    const cc = source.charCodeAt(pos);`);
  emit(`    // whitespace: ASCII \\s run by char loop; a non-ASCII candidate falls back to the regex`);
  emit(`    if (cc === 32 || (cc >= 9 && cc <= 13)) {`);
  emit(`      let wc = cc;`);
  emit(`      do {`);
  emit(`        if (wc === 10) pendingNl = true;`);
  emit(`        pos++;`);
  emit(`        wc = source.charCodeAt(pos);`);
  emit(`      } while (wc === 32 || (wc >= 9 && wc <= 13));`);
  emit(`      if (wc > 127) {`);
  emit(`        LX_WS.lastIndex = pos;`);
  emit(`        const m = LX_WS.exec(source);`);
  emit(`        if (m !== null) { if (m[0].includes('\\n')) pendingNl = true; pos += m[0].length; }`);
  emit(`      }`);
  emit(`      continue;`);
  emit(`    }`);
  emit(`    if (cc > 127) {`);
  emit(`      LX_WS.lastIndex = pos;`);
  emit(`      const m = LX_WS.exec(source);`);
  emit(`      if (m !== null) { if (m[0].includes('\\n')) pendingNl = true; pos += m[0].length; continue; }`);
  emit(`    }`);
  if (templateToken) {
    const mkClose = kwFirstCcs.has(tplInterpClose.charCodeAt(0)) ? 'lexMk' : 'lexMk0';
    const mkOpen = kwFirstCcs.has(tplOpen.charCodeAt(0)) ? 'lexMk' : 'lexMk0';
    emit(`    if (templateStack.length > 0) {`);
    emit(`      if (${startsWithExpr('source', 'pos', tplInterpClose, 'cc')}) {`);
    emit(`        const depth = templateStack[templateStack.length - 1];`);
    emit(`        if (depth === 0) {`);
    emit(`          templateStack.pop();`);
    emit(`          const startPos = pos;`);
    emit(`          const r = lexTplSpan(source, pos + ${tplInterpClose.length}, false);`);
    emit(`          if (r.endsWithInterp) {`);
    emit(`            push(${mkClose}('$templateMiddle', source.slice(startPos, r.end), startPos, ${kOf('$templateMiddle')}));`);
    emit(`            templateStack.push(0);`);
    emit(`          } else {`);
    emit(`            push(${mkClose}('$templateTail', source.slice(startPos, r.end), startPos, ${kOf('$templateTail')}));`);
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
    emit(`      const tagged = prevIsValue(tokens[tokens.length - 1]);`);
    emit(`      const startPos = pos;`);
    emit(`      const r = lexTplSpan(source, pos + ${tplOpen.length}, !tagged);`);
    emit(`      if (r.endsWithInterp) {`);
    emit(`        push(${mkOpen}('$templateHead', source.slice(startPos, r.end), startPos, ${kOf('$templateHead')}));`);
    emit(`        templateStack.push(0);`);
    emit(`      } else {`);
    emit(`        push(${mkOpen}(${J(templateToken.name)}, source.slice(startPos, r.end), startPos, ${kOf(templateToken.name)}));`);
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
  const groups = new Map<string, { ccs: number[]; ms: (typeof matchers)[number][]; ps: string[] }>();
  for (let cc = 0; cc < 128; cc++) {
    const { ms, ps } = actionsOf(cc);
    if (ms.length === 0 && ps.length === 0) continue;
    const sig = ms.map(m => m.name).join(',') + '|' + ps.join(',');
    if (!groups.has(sig)) groups.set(sig, { ccs: [], ms, ps });
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
      emit(`${ind}    if (!lexIdentValid(m[0], ${plen})) throw new Error("Invalid identifier escape at offset " + pos + ": '" + m[0] + "'");`);
    }
    if (m.skip) {
      emit(`${ind}    if (m[0].includes('\\n')) pendingNl = true;`);
    } else {
      emit(`${ind}    push(${canBeKw(m.first) ? 'lexMk' : 'lexMk0'}(${J(m.name)}, m[0], pos, ${m.k}));`);
    }
    emit(`${ind}    pos += m[0].length;`);
    emit(`${ind}    continue;`);
    emit(`${ind}  } }`);
  };
  const emitPunct = (lit: string, ind: string) => {
    // Chars 1..len-1 already known to match when this leaf is reached via the chain below.
    if (lit === '(') {
      emit(`${ind}{ const prev = tokens[tokens.length - 1];`);
      emit(`${ind}  const beforePrev = tokens[tokens.length - 2];`);
      emit(`${ind}  const isMemberName = beforePrev !== undefined && LX_MEMBER[beforePrev.t] !== 0;`);
      emit(`${ind}  parenHeadStack.push(!isMemberName && prev !== undefined && prev.k === ${kIdent} && LX_PARENKW[prev.t] !== 0); }`);
    } else if (lit === ')') {
      emit(`${ind}lastCloseWasParenHead = parenHeadStack.pop() ?? false;`);
    }
    if (regexCtx?.postfixAfterValueTexts?.includes(lit)) {
      emit(`${ind}lastBangWasPostfix = prevIsValue(tokens[tokens.length - 1]);`);
    }
    emit(`${ind}push(lexMkPu(${J(lit)}, pos, ${tOf(lit)}));`);
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

  emit(`    switch (cc) {`);
  for (const g of groups.values()) {
    emit(`      ${g.ccs.map(c => `case ${c}:`).join(' ')} {`);
    for (const m of g.ms) {
      if (m.isRegex) {
        emit(`        if (!prevIsValue(tokens[tokens.length - 1])) {`);
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
    emit(`    {`);
    emit(`      const prev = tokens[tokens.length - 1];`);
    const likeKs = [...identLike].map(kOf);
    const likeCond = likeKs.map(k => `prev.k === ${k}`).join(' || ');
    emit(`      if (prev !== undefined && (${likeCond}) && prev.offset + prev.text.length === pos) {`);
    emit(`        LX_UNI_CONT.lastIndex = pos;`);
    emit(`        const cont = LX_UNI_CONT.exec(source);`);
    emit(`        if (cont !== null) {`);
    emit(`          prev.text += cont[0];`);
    emit(`          prev.t = LIT_KW.get(prev.text) ?? 0;`);
    emit(`          pos += cont[0].length;`);
    emit(`          continue;`);
    emit(`        }`);
    emit(`      }`);
    emit(`    }`);
  }
  if (identTokenName) {
    emit(`    LX_UNI_IDENT.lastIndex = pos;`);
    emit(`    { const im = LX_UNI_IDENT.exec(source);`);
    emit(`      if (im !== null) {`);
    emit(`        push(lexMk(${J(identTokenName)}, im[0], pos, ${kOf(identTokenName)}));`);
    emit(`        pos += im[0].length;`);
    emit(`        continue;`);
    emit(`      } }`);
  }
  for (const pt of prefixedIdent) {
    emit(`    if (${startsWithExpr('source', 'pos', pt.prefix)}) {`);
    emit(`      LX_UNI_IDENT.lastIndex = pos + ${pt.prefix.length};`);
    emit(`      const pm = LX_UNI_IDENT.exec(source);`);
    emit(`      if (pm !== null) {`);
    emit(`        const text = ${J(pt.prefix)} + pm[0];`);
    emit(`        push(${kwFirstCcs.has(pt.prefix.charCodeAt(0)) ? 'lexMk' : 'lexMk0'}(${J(pt.name)}, text, pos, ${kOf(pt.name)}));`);
    emit(`        pos += text.length;`);
    emit(`        continue;`);
    emit(`      }`);
    emit(`    }`);
  }
  emit(`    throw new Error("Unexpected character at offset " + pos + ": '" + source[pos] + "'");`);
  emit(`  }`);
  emit(`  return tokens;`);
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
