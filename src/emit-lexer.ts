// The lexer generator — the ONE implementation of the grammar's lexical semantics. Every
// consumer runs code this file emits: the emitted parser module embeds it (TypeScript, with
// windowed re-lexing for incremental edits), and the interpreter (gen-parser.ts) compiles a
// standalone JavaScript tokenizer from it (compileTokenizer). Nothing dispatches over grammar
// data at runtime: matcher lists, first-char filters and punct-literal groups are baked into
// one `switch (charCode)` whose cases hold exactly the candidate regexes (declaration order)
// and a punct compare-chain (longest-first); regex-vs-division context and paren-head
// tracking are int-table loads on the token's interned k/t. The opt-in modes — markup
// (text / tag / raw-text), indentation (INDENT / DEDENT / NEWLINE, block scalars, raw blocks,
// flow collections, compact notation, tag-handle scope) and newline-only — are emitted only
// for a grammar that declares them, in the same main loop.
//
// Tokens land in struct-of-arrays columns (tkK/tkT/tkOff/tkEnd/tkFl/tkDp/tkPd + tokN) with
// no text: a token's text is always its source span (indent-mode engine tokens are zero-width;
// a newline-mode NEWLINE spans its line break).
// Flag bits: 1 newlineBefore, 2 commentBefore, 4 multilineFlowBefore, 8 '(' heads a control
// group. test/emit-lexer-verify.ts gates the output against the golden token streams.
import type { CstGrammar, ElementRegion, IndentConfig, MarkupConfig, NewlineConfig, TokenDecl, TokenPattern } from './types.ts';
import { collectLiterals, gtComposites, isKeywordLiteral } from './grammar-utils.ts';
import { type Directives, directivesOf, tagOpenOnlyOpensTags } from './grammar-analysis.ts';
import { UNI_ID_CONTINUE, UNI_ID_START } from './uni-ident.ts';
import { type CSet, continuesAt, examinedUnits as examinedUnitsOf, failRead, failReadFirst, info as patternInfo, oneChar, overTrigger, readEndWalk, union } from './lex-match-plan.ts';
import {
  tokenBlockPatternFirstCharSet, tokenBlockPatternSource, tokenEscapeValidPatternSource, tokenPatternCharLoop,
  tokenPatternAnchorKinds, tokenPatternFirstCharSet, tokenPatternSource,
} from './token-pattern.ts';

// The public token model: fresh objects owned by the caller.
// type = the token decl name, '' for a punctuation literal, or one of the synthetic template
// piece types `$templateHead/$templateMiddle/$templateTail`; text = source.slice(offset, end).
export interface Token {
  type: string;
  text: string;
  offset: number;
  k: number;      // interned TYPE kind
  t: number;      // interned LITERAL kind: keyword int for a named token's text, punct int for a '' token's
  newlineBefore: boolean;        // a line terminator preceded this token (ASI / "no LineTerminator here")
  commentBefore: boolean;        // a comment was skipped before this token (a comment ENDS a plain scalar)
  multilineFlowBefore: boolean;  // the flow collection that closed right before this token spanned >1 line
}

// Everything the lexer reads from a grammar: the token declarations, the literal vocabulary
// (rule literals + operator values — the punctuation table), and the mode configs.
export interface LexSpec {
  tokens: TokenDecl[];
  literals: string[];
  // Literals the lexer never forms (they keep their ids): the parser composes them (gtComposites).
  composed?: string[];
  markup?: MarkupConfig | null;
  elements?: ElementRegion | null;
  // How code enters an element region (derived: grammar-analysis.ts tagOpenOnlyOpensTags):
  // 'always' = every `tagOpen` in code opens an element; ABSENT = only one where an operand
  // may start (`!prevIsValue()` and the `typeParameters` vetoes).
  elementEntry?: 'always';
  // The region's directives (derived: grammar-analysis.ts directivesOf); ABSENT when it has none.
  elementDirectives?: Directives;
  indent?: IndentConfig | null;
  newline?: NewlineConfig | null;
}

export function lexSpecOf(grammar: CstGrammar): LexSpec {
  const lits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) lits.add(l);
  for (const level of grammar.precs) for (const op of level.operators) lits.add(op.value);
  return { tokens: grammar.tokens, literals: [...lits], composed: gtComposites(grammar), markup: grammar.markup,
    ...(grammar.elements ? { elements: grammar.elements, ...(tagOpenOnlyOpensTags(grammar, grammar.elements) ? { elementEntry: 'always' as const } : {}), ...directivesSpec(grammar, grammar.elements) } : {}), indent: grammar.indent, newline: grammar.newline };
}
// The derived directives, or a loud refusal of every arm the lexer could not find in text.
function directivesSpec(grammar: CstGrammar, region: ElementRegion): { elementDirectives?: Directives } {
  const d = directivesOf(grammar, region);
  if (d === null) return {};
  if (d.refused.length) throw new Error(`elements: ${d.refused.length} directive arm(s) the lexer cannot find in text (docs/REGIONS.md, "Directives"):\n${d.refused.map(r => `  ${r.arm}: ${r.reason}`).join('\n')}`);
  return d.openers.length || d.blocks.length ? { elementDirectives: d } : {};
}

export interface LexerSymtab {
  typeKind: Map<string, number>;
  kwLitKind: Map<string, number>;
  puLitKind: Map<string, number>;
  KIND_PUNCT: number;
  KIND_NAMED_FALLBACK: number;
}

// The interned id spaces for a spec alone (the emitted parser derives a superset from its
// grammar analysis and passes that instead): '' = 1, the three template pieces 2..4, declared
// token names from 5, '$error' (a recovered unexpected character) one past them; literal ints
// keyword-first, punctuation after.
export function lexSymtab(spec: LexSpec): LexerSymtab {
  const typeKind = new Map<string, number>([['', 1], ['$templateHead', 2], ['$templateMiddle', 3], ['$templateTail', 4]]);
  let next = 5;
  for (const t of spec.tokens) if (!typeKind.has(t.name)) typeKind.set(t.name, next++);
  typeKind.set('$error', next);
  const kwLitKind = new Map<string, number>(), puLitKind = new Map<string, number>();
  let lit = 1;
  for (const l of spec.literals) if (isKeywordLiteral(l) && !kwLitKind.has(l)) kwLitKind.set(l, lit++);
  for (const l of spec.literals) if (!isKeywordLiteral(l) && !puLitKind.has(l)) puLitKind.set(l, lit++);
  return { typeKind, kwLitKind, puLitKind, KIND_PUNCT: 1, KIND_NAMED_FALLBACK: next };
}

// Column element types: Uint8 when the kind / literal id spaces fit a byte.
export function columnTypes(st: LexerSymtab): { kArr: string; tArr: string } {
  const tMax = Math.max(1, ...st.kwLitKind.values(), ...st.puLitKind.values());
  return { kArr: st.KIND_NAMED_FALLBACK <= 255 ? 'Uint8Array' : 'Uint16Array', tArr: tMax <= 255 ? 'Uint8Array' : 'Uint16Array' };
}

// Type annotations in emitted source are written «like this»: kept (markers dropped) for
// TypeScript output, removed for JavaScript output. Grammar strings reach the source only
// through J (which escapes the markers) or as numbers.
const J = (v: unknown) => JSON.stringify(v).replace(/«/g, '\\u00ab').replace(/»/g, '\\u00bb');
const finish = (src: string, ts: boolean) => ts ? src.replace(/[«»]/g, '') : src.replace(/«[^»]*»/g, '');

// The token columns the lexer writes, with their growth and the EOF-relative span decode
// (an incremental session stores suffix spans as value − (srcLen + 1); batch lexes are all
// positive).
export function emitTokenColumns(st: LexerSymtab, ts: boolean): string {
  const { kArr, tArr } = columnTypes(st);
  return finish(String.raw`// ── Token stream: struct-of-arrays (no per-token object, no eager text) ──
// tkK = type kind, tkT = literal kind, tkOff/tkEnd = source span, tkFl = stamp bits
// (1 newlineBefore, 2 commentBefore, 4 multilineFlowBefore, 8 control-head '('). Token text is
// its source span, materialized only on demand. The arrays persist across lexes and grow by
// doubling.
let tkK = new ${kArr}(4096);
let tkT = new ${tArr}(4096);
let tkOff = new Int32Array(4096);
let tkEnd = new Int32Array(4096);
let tkFl = new Uint8Array(4096);
// lexer-state depth records per token (windowed relex restart/resync safety):
// tkDp = template-interp stack depth, tkPd = paren-head stack depth, both AS RECORDED
// at the token's push.
let tkDp = new Uint8Array(4096);
let tkPd = new Uint16Array(4096);
let tkCap = 4096;
let tokN = 0;
let srcLenP1 = 1;
let negFrom = 0x7fffffff;
function toff(i«: number») { const v = tkOff[i]; return v < 0 ? v + srcLenP1 : v; }
function tend(i«: number») { const v = tkEnd[i]; return v < 0 ? v + srcLenP1 : v; }
function growTok() {
  tkCap *= 2;
  const k = new ${kArr}(tkCap); k.set(tkK); tkK = k;
  const t = new ${tArr}(tkCap); t.set(tkT); tkT = t;
  const o = new Int32Array(tkCap); o.set(tkOff); tkOff = o;
  const e2 = new Int32Array(tkCap); e2.set(tkEnd); tkEnd = e2;
  const f = new Uint8Array(tkCap); f.set(tkFl); tkFl = f;
  const d = new Uint8Array(tkCap); d.set(tkDp); tkDp = d;
  const q = new Uint16Array(tkCap); q.set(tkPd); tkPd = q;
}`, ts);
}

// A standalone tokenizer module: columns + the lexer + `tokenize(source): Token[]`.
// The lexer reads `recovering` / `docLex` (recovery is the emitted parser's concern; here it
// is off, so every lex error throws).
export function emitTokenizerModule(spec: LexSpec, st: LexerSymtab = lexSymtab(spec)): string {
  const names: string[] = [];
  for (const [n, k] of st.typeKind) names[k] = n;
  return [
    `const K_PUNCT = ${st.KIND_PUNCT};`,
    `const K_NAMES = ${J(names)};`,
    `const recovering = false;`,
    `const docLex = [];`,
    emitTokenColumns(st, false),
    emitLexer(spec, st, { ts: false, windowed: false }).code,
    `function tokenize(source) {`,
    `  lexFull(source);`,
    `  const out = new Array(tokN);`,
    `  for (let i = 0; i < tokN; i++) {`,
    `    const off = tkOff[i], fl = tkFl[i];`,
    `    out[i] = { type: K_NAMES[tkK[i]] ?? '', text: source.slice(off, tkEnd[i]), offset: off, k: tkK[i], t: tkT[i],`,
    `      newlineBefore: (fl & 1) !== 0, commentBefore: (fl & 2) !== 0, multilineFlowBefore: (fl & 4) !== 0 };`,
    `  }`,
    `  return out;`,
    `}`,
  ].join('\n');
}

// The generated tokenizer, compiled in-process (new Function — needs `unsafe-eval` under a
// Content-Security-Policy; emitted parser modules never evaluate code).
export function compileTokenizer(spec: LexSpec): (source: string) => Token[] {
  return new Function(emitTokenizerModule(spec) + '\nreturn tokenize;')();
}

// The resync retract one-liner is emitted at two points in the relex loop (mid-loop and the
// post-loop EOF check); a single producer keeps the two from drifting (#45 B3).
const resyncRetractLine = (indent: string): string =>
  `${indent}if (wndHit >= 0) { tokN--; while (docLex.length > lexDiagBase && docLex[docLex.length - 1].offset >= tkOff[tokN]) docLex.length--; return wndHit; }`;

// The non-ASCII members of JS \s (the /u-free set), baked as a charCode test so a
// non-whitespace cc>127 (e.g. a Unicode identifier char) skips the LX_WS regex entirely. The
// regex `/\s+/y` matches at pos iff the lead char is \s, and ASCII \s is handled by the char
// loop, so `cc>127 && lxNonAsciiWs(cc)` is EXACTLY "the regex would match here" (#45 B4).
const NON_ASCII_WS_FN =
  `function lxNonAsciiWs(cc«: number») { return cc === 0xa0 || cc === 0x1680 || (cc >= 0x2000 && cc <= 0x200a) || cc === 0x2028 || cc === 0x2029 || cc === 0x202f || cc === 0x205f || cc === 0x3000 || cc === 0xfeff; }`;
// The non-ASCII whitespace fallback, emitted at the two sites that need it (after an ASCII run,
// and as the lead char). `cont` appends the `continue` the lead-char site needs.
const nonAsciiWsConsume = (v: string, cont: boolean, indent: string): string =>
  `${indent}if (${v} > 127 && lxNonAsciiWs(${v})) { LX_WS.lastIndex = pos; const m = LX_WS.exec(source); if (m !== null) { if (/[\\n\\r\\u2028\\u2029]/.test(m[0])) pendingNl = true; pos += m[0].length;${cont ? ' continue;' : ''} } }`;

type FirstSet = { ascii: Set<number>; nonAscii: boolean } | null;

// A failed attempt that reads at most this many units from the start of the token it decides
// reads within that token's end + 1 (a token is at least one unit): the relex window covers it.
const FREE_FAIL = 2;
// Whether UTF-16 unit `v` is one of `set` (EOF, -1, is never tested: callers bound v first).
function unitIn(v: string, set: CSet): string {
  const rs = set.map(([a, b]): [number, number] => [Math.max(0, a), Math.min(0xffff, b)]).filter(([a, b]) => a <= b);
  if (rs.length === 1 && rs[0][0] === 0 && rs[0][1] === 0xffff) return 'true';
  return rs.length ? `(${rs.map(([a, b]) => (a === b ? `${v} === ${a}` : `(${v} >= ${a} && ${v} <= ${b})`)).join(' || ')})` : 'false';
}
// The read-end routine of a pattern's failed attempt at p (readEndWalk, src/lex-match-plan.ts):
// the exclusive end of what it read.
function emitReadEnd(emit: (s?: string) => void, name: string, p: TokenPattern) {
  const w = readEndWalk(p);
  emit(`function ${name}(s«: string», p«: number») {`);
  emit(`  let q = p;`);
  for (const it of w.lead) {
    if ('lit' in it) emit(`  if (!s.startsWith(${JSON.stringify(it.lit)}, q)) return q + ${it.lit.length}; q += ${it.lit.length};`);
    else emit(`  if (q >= s.length) return q + 1; { const c = s.charCodeAt(q); if (!${unitIn('c', it.cls)}) return q + 1; } q++;`);
  }
  const past = unitIn('c', w.past);
  if (past === 'true') emit(`  return s.length + 1;`);
  else if (past === 'false') emit(`  return q + 1;`);
  else { emit(`  while (q < s.length) { const c = s.charCodeAt(q); if (!${past}) break; q++; }`); emit(`  return q + 1;`); }
  emit(`}`);
}
// The over-read routine of a pattern's match ending at e, called when the unit at e is one at which
// it can read more than one unit past e (overTrigger): the exclusive end of what it read, through
// the units the pattern examines.
function emitOverEnd(emit: (s?: string) => void, name: string, p: TokenPattern) {
  emit(`function ${name}(s«: string», e«: number») {`);
  const past = unitIn('c', examinedUnitsOf(p));
  emit(past === 'true' ? `  return s.length + 1;` : `  let q = e; while (q < s.length) { const c = s.charCodeAt(q); if (!${past}) break; q++; } return q + 1;`);
  emit(`}`);
}

// Emit the lexer for `spec` over the id spaces of `st`.
//   windowed — the incremental-relex machinery (resync against the previous stream,
//              restart anchors, paren-stack reconstruction) the emitted parser drives;
//              a stateful grammar (markup / indent / newline mode) always re-lexes from the
//              file head, so its restart anchor is fixed at -1.
// Reads from its host: tkK… columns (emitTokenColumns), K_PUNCT, recovering, docLex, and in
// windowed mode the alt* spare columns + docEmptyPops.
export function emitLexer(spec: LexSpec, st: LexerSymtab, opts: { ts: boolean; windowed: boolean }): { code: string; stateful: boolean } {
  const markup = spec.markup ?? undefined;
  const indent = spec.indent ?? undefined;
  const newline = spec.newline ?? undefined;
  // Element regions (JSX): frames on the template-hole stack. Encoding of one frame (number):
  // low 2 bits = kind (0 template hole, 1 element hole, 2 element text frame); a hole keeps its
  // brace count in the bits above (step 4); a text frame keeps its sub-state in bits 2-3
  // (0 children text, 1 open tag, 2 close tag) and its open-element count above (step 16).
  // Without `elements` every frame is a template hole and the encoding is the plain count.
  const el = spec.elements ?? undefined;
  // a lexer that speculating on a type-parameter signature: inside it, an error is the verdict,
  // never a recovered token (\`specTok\` below)
  const speculating = !!el?.typeParameters?.signature;
  // every tagOpen in code opens an element (the grammar uses it for nothing else)
  const enterAlways = !!el && spec.elementEntry === 'always';
  if (enterAlways && el!.typeParameters) throw new Error(`elements.typeParameters: this grammar uses '${el!.tagOpen}' only to open tags, so no '${el!.tagOpen}' can begin a type-parameter list`);
  const recov = speculating ? '(recovering && specTok < 0)' : 'recovering';
  const lineSensitive = !!indent || !!newline;
  const stateful = !!markup || lineSensitive;
  const windowed = opts.windowed;
  const resync = windowed && !stateful;
  // The relex anchor rule (src/relex-family.ts states it): a token is decided by everything its
  // lexer read, its own match and the failed attempts before it at its start. The windowed relex
  // keeps the old tokens up to B, the last token ending before the edit, and lexes on from B's
  // end: that is sound when nothing that decided B or a token before it read past B's end + 1
  // (exclusive: up to the unit right after B, which is before the edit). The reads that can go
  // further are tracked while lexing: \`lxLookEnd\` is the exclusive end of the furthest read any
  // decision so far made, and a token pushed while it is past the token's end + 1 carries flag 32:
  // no restart anchor (findRestart) and no resync point. Only a lexer that restarts at anchors (a
  // resync lexer) tracks it; the tokenizer the interpreter runs does not.
  const looks = resync;

  const out: string[] = [];
  const emit = (s = '') => out.push(s);

  const composed = new Set(spec.composed ?? []);
  const punctLiterals = [...new Set(spec.literals)].filter(l => !isKeywordLiteral(l) && !composed.has(l)).sort((a, b) => b.length - a.length);
  const punctByFirstCc = new Map<number, string[]>();
  for (const lit of punctLiterals) {
    const cc = lit.charCodeAt(0);
    if (!punctByFirstCc.has(cc)) punctByFirstCc.set(cc, []);
    punctByFirstCc.get(cc)!.push(lit);
  }

  const identTokenName = spec.tokens.find(t => t.identifier)?.name;
  const prefixedIdent = spec.tokens
    .filter(t => t.identifierPrefix)
    .map(t => ({ name: t.name, prefix: t.identifierPrefix as string }));
  const identPrefixByName = new Map<string, string>(prefixedIdent.map(t => [t.name, t.prefix]));
  const identLike = new Set<string>([identTokenName, ...prefixedIdent.map(t => t.name)].filter(Boolean) as string[]);

  const templateToken = spec.tokens.find(t => t.template);
  const tplOpen = templateToken?.template?.open ?? '';
  const tplInterpOpen = templateToken?.template?.interpOpen ?? '';
  const tplInterpClose = templateToken?.template?.interpClose ?? '';
  const tplBraceOpen = tplInterpOpen.slice(-1);
  const tplEscapeValid = templateToken ? tokenEscapeValidPatternSource(templateToken) : undefined;

  const regexCtx = spec.tokens.find(t => t.regexContext)?.regexContext;
  const kOf = (name: string) => st.typeKind.get(name) ?? st.KIND_NAMED_FALLBACK;
  const tOf = (text: string) => (isKeywordLiteral(text) ? st.kwLitKind.get(text) : st.puLitKind.get(text)) ?? 0;
  const puT = (text: string) => st.puLitKind.get(text) ?? 0;
  let tSize = 1;
  for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
  for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
  const kSize = st.KIND_NAMED_FALLBACK + 1;

  // ── Mode configuration (all dormant unless declared) ──
  // Engine-emitted token types: matched by the state machines, never by the regex scan.
  const markupTokenNames = new Set<string>(
    [markup?.textToken, markup?.rawText?.token, markup?.comment?.token, markup?.voidNameToken,
     markup?.unquotedValueToken].filter(Boolean) as string[],
  );
  // Region tokens: lexed only inside their element region, never by the ordinary scan.
  const elTokenNames = new Set<string>(el ? [el.text, el.closeTag, el.selfClose, ...el.tagTokens ?? [], ...(el.rawText ?? []).map(r => r.token)].filter((x): x is string => !!x) : []);
  const lineTokenNames = new Set<string>(
    indent ? [indent.indentToken, indent.dedentToken, indent.newlineToken].filter(Boolean)
           : newline ? [newline.token] : [],
  );
  // The structural (non-content) token types: a push of one leaves `emittedContent` /
  // `atLineLead` untouched. Block-scalar and raw-block tokens count as structural here while
  // still being regular scan matchers.
  const structTokenNames = new Set<string>([...lineTokenNames,
    ...(indent?.blockScalar ? [indent.blockScalar.token] : []), ...(indent?.rawBlock ? [indent.rawBlock.token] : [])]);
  const flowOpen = (indent ?? newline)?.flowOpen ?? [];
  const flowClose = (indent ?? newline)?.flowClose ?? [];
  const lineComment = indent?.comment;
  const keyValueSep = indent?.keyValueSeparator ?? ':';
  const foldTokens = indent?.foldTokens ?? [];
  const plainContName = foldTokens.length ? foldTokens[foldTokens.length - 1] : null;
  const plainContDecl = plainContName ? spec.tokens.find(t => t.name === plainContName) : undefined;
  const docMarkers = indent?.blockScalar?.documentMarkers ?? [];
  const compactIndicators = indent?.compactIndicators ?? [];
  const tagScope = indent?.tagScope;
  const indentComment = indent?.comment;

  // A 0/1 byte table over the t space (literal texts) or k space (token-type names).
  const litTable = (name: string, texts: Iterable<string>) => {
    const a = new Array<number>(tSize).fill(0);
    for (const x of texts) { const t = tOf(x); if (t > 0) a[t] = 1; }
    emit(`const ${name} = Uint8Array.from([${a.join(',')}]);`);
  };
  const typeTable = (name: string, types: Iterable<string>) => {
    const a = new Array<number>(kSize).fill(0);
    for (const x of types) { const k = st.typeKind.get(x); if (k !== undefined) a[k] = 1; }
    emit(`const ${name} = Uint8Array.from([${a.join(',')}]);`);
  };
  // `source` text at token i equals `lit` (any token type).
  const textIs = (i: string, lit: string) => {
    const parts = [`tkEnd[${i}] - tkOff[${i}] === ${lit.length}`];
    for (let j = 0; j < lit.length; j++) parts.push(`source.charCodeAt(tkOff[${i}] - lexSrcBase${j ? ` + ${j}` : ''}) === ${lit.charCodeAt(j)}`);
    return `(${parts.join(' && ')})`;
  };
  // A punctuation token i whose text is one of `lits` (false when none is in the vocabulary).
  const punctIs = (i: string, lits: string[]) => {
    const ts = [...new Set(lits.map(puT).filter(t => t > 0))];
    return ts.length ? `(tkK[${i}] === K_PUNCT && (${ts.map(t => `tkT[${i}] === ${t}`).join(' || ')}))` : 'false';
  };
  const ccIn = (v: string, chars: string[]) => {
    const cs = [...new Set(chars.filter(c => c.length === 1).map(c => c.charCodeAt(0)))];
    return cs.length ? `(${cs.map(c => `${v} === ${c}`).join(' || ')})` : 'false';
  };

  // A regex's `^` is the start of the text (start()) without the multiline flag and the start of a
  // line (lineStart()) with it; one regex cannot hold both.
  const anchorFlags = (t: (typeof spec.tokens)[number]): string => {
    const ks = tokenPatternAnchorKinds(t.pattern);
    if (ks.has('start') && ks.has('lineStart')) throw new Error(`emit-lexer: token ${t.name} has both a start() and a lineStart() anchor`);
    return ks.has('lineStart') ? 'ym' : 'y';
  };
  // The scan matchers, in declaration order, with their baked regexes and per-matcher facts.
  const matchers = spec.tokens
    .filter(t => t.name !== templateToken?.name && !markupTokenNames.has(t.name) && !lineTokenNames.has(t.name) && !elTokenNames.has(t.name))
    .map((t, idx) => {
      const blockPattern = tokenBlockPatternSource(t);
      const id = `${idx}_${t.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
      return {
        name: t.name,
        re: `LXRE_${id}`,
        blockRe: blockPattern ? `LXRB_${id}` : null,
        pattern: tokenPatternSource(t),
        blockPattern,
        flags: anchorFlags(t),
        skip: t.flags.includes('skip'),
        isRegex: t.flags.includes('regex'),
        isString: !!t.string,
        blockOnly: !!t.blockOnly,
        first: tokenPatternFirstCharSet(t) as FirstSet,
        blockFirst: (blockPattern ? tokenBlockPatternFirstCharSet(t) : null) as FirstSet,
        k: kOf(t.name),
        identLike: identLike.has(t.name),
        loop: tokenPatternCharLoop(t),
        // The relex anchor rule (src/relex-family.ts): what a failed attempt / a match reads past
        // the end + 1 of the token it decides (`lxLookEnd` below); null when it cannot.
        readEnd: looks && failRead(t.pattern) > FREE_FAIL ? `lxReadEnd_${id}` : null,
        overEnd: looks && overTrigger(t.pattern).length > 0 ? `lxOverEnd_${id}` : null,
        tokenPattern: t.pattern,
      };
    });
  type M = (typeof matchers)[number];

  emit(`// ── Emitted lexer (emit-lexer.ts): specialized tokenize for this grammar ──`);
  for (const m of matchers) {
    emit(`const ${m.re} = new RegExp(${J(`(?:${m.pattern})`)}, ${J(m.flags)});`);
    if (m.blockRe) emit(`const ${m.blockRe} = new RegExp(${J(`(?:${m.blockPattern})`)}, ${J(m.flags)});`);
  }
  // The reads past a token's end + 1 (\`looks\`): per matcher, its failed attempt's read end and its
  // match's over-read; the type-parameter head veto's match decides the tagOpen before it.
  const headOverEnd = looks && el?.typeParameters?.head ? 'lxOverEndTpHead' : null;
  // directive tests read past the token they decide (trivia after the literal)
  const dirs = el && spec.elementDirectives ? spec.elementDirectives : null;
  const tracks = matchers.some(m => m.readEnd || m.overEnd) || headOverEnd !== null || (looks && dirs !== null);
  for (const m of matchers) {
    if (m.readEnd) emitReadEnd(emit, m.readEnd, m.tokenPattern);
    if (m.overEnd) emitOverEnd(emit, m.overEnd, m.tokenPattern);
  }
  if (headOverEnd) emitOverEnd(emit, headOverEnd, el!.typeParameters!.head!);
  emit(`const LX_WS = /\\s+/y;`);
  emit(NON_ASCII_WS_FN);
  emit(`// window-truncation retry: a matcher failing at the WINDOW edge is not a lex`);
  emit(`// error — the caller re-materializes a larger window`);
  emit(`const LEX_RETRY = { retry: true };`);
  emit(`let lexWindowMore = false;`);
  emit(`let lexSrcBase = 0;`);
  emit(`let lexDiagBase = 0;   // docLex floor for the current window (its own emissions sit above)`);
  // A type-parameter signature being decided (\`<T>(x: T) => T\`, ElementRegion.typeParameters):
  // the token index of its tagOpen, -1 when none. Module level, because a lex error ANYWHERE while
  // it is undecided (lexTplSpan included) is its rewind verdict, in the recovering pass as in the
  // strict one: the two passes must lex the same stream.
  if (speculating) emit(`let specTok = -1;`);
  emit(`// ')' pops that found an empty stack, in THIS lexCore call's token indices`);
  emit(`let lexEmptyPops«: number[]» = [];`);
  if (windowed) {
    emit(`// Shifted-resync support: lexResyncPd is the paren-depth delta between the live`);
    emit(`// stack and the old record at the adopted suffix's first token (the splice adds`);
    emit(`// it to every adopted tkPd, restoring true absolute depths). altSuffMin[j] =`);
    emit(`// min paren depth recorded over the old suffix [j, altN) (pop-on-empty = -1),`);
    emit(`// built lazily once per edit (the caller nulls it when the alt stream changes).`);
    emit(`let lexResyncPd = 0;`);
    emit(`let altSuffMin«: Int32Array | null» = null;`);
    emit(`let altSuffMinBuf«: Int32Array | null» = null;`);
    emit(`// Min OLD-stream paren depth over the tokens inside the damage itself (set by the`);
    emit(`// caller before the window lex): the old-side trajectory min starts from here.`);
    emit(`let wndOldMin0 = 0x7fffffff;`);
  }
  if (resync) {
    emit(`// A token's place on the paren-depth trajectory: its recorded depth, except a '(' (which`);
    emit(`// records the depth INCLUDING its own entry) stands at the depth before its push. An entry`);
    emit(`// pushed after the divergence point is then never "at or below both minimums", so the fast`);
    emit(`// resync tier compares only entries both lexes had (\`if (q)\` vs \`ifx (q)\` differ in theirs).`);
    emit(`function lxPdBefore(k«: number», t«: number», pd«: number») { return k === K_PUNCT && t === ${tOf('(')} ? pd - 1 : pd; }`);
    emit(`function buildAltSuffMin(lo«: number») {`);
    emit(`  if (altSuffMinBuf === null || altSuffMinBuf.length < altN + 1) altSuffMinBuf = new Int32Array(altN + 1025);`);
    emit(`  altSuffMin = altSuffMinBuf;`);
    emit(`  altSuffMin«!»[altN] = 0x7fffffff;`);
    emit(`  for (let j = altN - 1; j >= lo; j--) {`);
    emit(`    let d = altPd«!»[j];`);
    emit(`    if (d === 0 && altK«!»[j] === K_PUNCT && altT«!»[j] === ${tOf(')')} && (j === 0 || altPd«!»[j - 1] === 0)) d = -1;`);
    emit(`    const nx = altSuffMin«!»[j + 1];`);
    emit(`    altSuffMin«!»[j] = d < nx ? d : nx;`);
    emit(`  }`);
    emit(`}`);
  }
  emit(`const LX_UNI_IDENT = /${UNI_ID_START}${UNI_ID_CONTINUE}*/uy;`);
  // The extension of an identifier the ASCII pattern cut short: it begins only at a unit BEYOND
  // ASCII (an ASCII unit the pattern leaves out where it stopped, `$` in `[A-Za-z_]\w*`, is not
  // part of the token: the token's own pattern decides ASCII), then takes the whole IdentifierPart
  // run, ASCII included (`na|ïve` is one identifier), as the portable lexers' lxExt does
  // (docs/TARGETS.md).
  emit(`const LX_UNI_CONT = /(?![\\0-\\x7f])${UNI_ID_CONTINUE}+/uy;`);
  emit(`const LX_UNI_FULL = /^${UNI_ID_START}${UNI_ID_CONTINUE}*/u;`);
  emit(`const LX_DECODE_ESC = /\\\\u\\{([0-9a-fA-F]+)\\}|\\\\u([0-9a-fA-F]{4})/g;`);
  if (tplEscapeValid) emit(`const LX_TPL_ESC = new RegExp(${J(tplEscapeValid)}, 'y');`);
  // Regex-vs-division context tables (over interned k / t ints).
  litTable(`LX_PFXV`, regexCtx?.postfixAfterValueTexts ?? []);
  litTable(`LX_EXPRKW`, regexCtx?.regexAfterTexts ?? []);
  litTable(`LX_DIVT`, regexCtx?.divisionAfterTexts ?? []);
  typeTable(`LX_DIVK`, [...(regexCtx?.divisionAfterTypes ?? []), '$templateTail']);
  litTable(`LX_PARENKW`, regexCtx?.regexAfterParenKeywords ?? []);
  litTable(`LX_MEMBER`, regexCtx?.memberAccessTexts ?? []);
  if (indent) typeTable(`LX_STRUCT`, structTokenNames);
  if (lineSensitive) {
    litTable(`LX_FLOWOPEN`, flowOpen);
    litTable(`LX_FLOWCLOSE`, flowClose);
  }
  if (indent) {
    typeTable(`LX_FOLD`, foldTokens);
    typeTable(`LX_FLOWSEP`, indent.flowSeparatorAfterTokens ?? []);
  }
  if (markup) {
    emit(`const LX_RAW_TAGS = new Set(${J((markup.rawText?.tags ?? []).map(t => t.toLowerCase()))});`);
    emit(`const LX_VOID_TAGS = new Set(${J((markup.voidTags ?? []).map(t => t.toLowerCase()))});`);
    if (markup.tagOpenAfter) emit(`const LX_TAG_OPEN_AFTER = new RegExp(${J('[' + markup.tagOpenAfter + ']')});`);
    if (markup.unquotedValueToken) {
      // Bounds an unquoted attribute value: everything except whitespace, the attribute quotes,
      // the tag delimiters, the assign char and a backtick (mirrors gen-tm's value pattern).
      const ccEscape = (s: string) => s.replace(/[\[\]\\^-]/g, '\\$&');
      const quotes = markup.attributeQuotes ?? ['"', "'"];
      emit(`const LX_UNQUOTED = new RegExp(${J('[^\\s' + ccEscape(quotes.join('') + markup.tagOpen + markup.tagClose + (markup.attributeAssign ?? '=') + '`') + ']+')}, 'y');`);
    }
  }
  if (el) {
    const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    if (el.text !== undefined) {
      const textDecl = spec.tokens.find(t => t.name === el.text);
      if (!textDecl) throw new Error(`elements.text: no token named '${el.text}'`);
      // The children text run is the text token's own pattern (a run of a character class).
      emit(`const LX_EL_TEXT = new RegExp(${J(`(?:${tokenPatternSource(textDecl)})`)}, 'y');`);
    }
    (el.tagTokens ?? []).forEach((name, i) => {
      const d = spec.tokens.find(t => t.name === name);
      if (!d) throw new Error(`elements.tagTokens: no token named '${name}'`);
      emit(`const LX_EL_TAG_${i} = new RegExp(${J(`(?:${tokenPatternSource(d)})`)}, 'y');`);
    });
    if (el.rawText?.length) {
      // raw-text tag names → the raw token's kind: exact names, and ASCII-case-folded ones
      const exact: [string, number][] = [], fold: [string, number][] = [];
      for (const r of el.rawText) {
        if (!spec.tokens.some(t => t.name === r.token)) throw new Error(`elements.rawText: no token named '${r.token}'`);
        for (const tag of r.tags) (r.ignoreCase ? fold : exact).push([r.ignoreCase ? tag.toLowerCase() : tag, kOf(r.token)]);
      }
      emit(`const LX_RAW_EXACT = new Map«<string, number>»(${J(exact)});`);
      emit(`const LX_RAW_FOLD = new Map«<string, number>»(${J(fold)});`);
      // the close tag of a case-folded raw-text element, in any ASCII case
      emit(`const LX_RAW_FOLD_END = new Map«<string, RegExp>»([${fold.map(([tag]) => `[${J(tag)}, new RegExp(${J(reEsc(el.tagOpen + el.closeMarker + tag))}, 'gi')]`).join(', ')}]);`);
      if (el.rawText.some(r => r.unlessBodyStarts !== undefined)) {
        // per raw-text name (exact, or case-folded): the body-start pattern under which its body is
        // ordinary children, not raw
        const un = (fold: boolean) => el.rawText!.filter(r => !!r.ignoreCase === fold && r.unlessBodyStarts !== undefined)
          .flatMap(r => r.tags.map(tag => `[${J(fold ? tag.toLowerCase() : tag)}, new RegExp(${J(`(?:${tokenPatternSource({ pattern: r.unlessBodyStarts! })})`)}, 'y')]`)).join(', ');
        emit(`const LX_RAW_UNLESS_EXACT = new Map«<string, RegExp>»([${un(false)}]);`);
        emit(`const LX_RAW_UNLESS_FOLD = new Map«<string, RegExp>»([${un(true)}]);`);
      }
    }
    if (el.tagStart !== undefined) {
      // a tagOpen opens a tag only when the unit after it is one of the tag-start class
      if (!oneChar(el.tagStart)) throw new Error('elements.tagStart: must be a one-unit class');
      emit(`function lxTagStart(s«: string», p«: number») { if (p >= s.length) return false; const c = s.charCodeAt(p); return ${unitIn('c', patternInfo(el.tagStart).first)}; }`);
    }
    const dd = spec.elementDirectives;
    if (dd) {
      // the derived directives (grammar-analysis.ts directivesOf): [literal, 1 = a word literal /
      // 2 = a code block opener / 0, the required literal sequences ([literal, word])]
      const idc = patternInfo(spec.tokens.find(t => t.identifier)?.pattern ?? '').chars;
      const word = (l: string) => { const u = l.charCodeAt(l.length - 1); return idc.some(([a, b]) => u >= a && u <= b) ? 1 : 0; };
      const row = (d: { lit: string; nexts: string[][] }, block = false) => [d.lit, block ? 2 : word(d.lit), d.nexts.map(n => n.map(l => [l, word(l)]))];
      emit(`const LX_DIR_OPEN«: [string, number, [string, number][][]][]» = ${J([...dd.openers.map(d => row(d)), ...dd.blocks.map(b => row({ lit: b, nexts: [[]] }, true))])};`);
      emit(`const LX_DIR_CONT«: [string, number, [string, number][][]][]» = ${J(dd.continuations.map(d => row(d)))};`);
      emit(`function lxIdCont(c«: number») { return ${unitIn('c', idc)}; }`);
    }
    const tp = el.typeParameters;
    if (tp?.head) emit(`const LX_TP_HEAD = new RegExp(${J(`(?:${tokenPatternSource({ pattern: tp.head })})`)}, 'y');`);
    if (tp?.signature) {
      const identDecl = spec.tokens.find(t => t.identifier);
      if (!identDecl) throw new Error('elements.typeParameters.signature needs the identifier token');
      emit(`const LX_TP_SIG = new RegExp(${J(`\\s*(?:${tokenPatternSource(identDecl)})\\s*${reEsc(el.tagClose)}\\s*${reEsc(tp.signature.open)}`)}, 'y');`);
      litTable(`LX_SIG_THEN`, tp.signature.then);
    }
  }
  if (indent?.blockScalar) {
    // Block-scalar header signature: introducer + indicators + optional ` #` comment to EOL.
    emit(`const LX_BS_SIG = /[|>](?:[1-9][+-]?|[+-][1-9]?|[+-]|)[ \\t]*(?:(?<=[ \\t])#[^\\n]*)?(?:\\r?\\n|$)/y;`);
    emit(`const LX_BS_IND = /[+-]?([1-9])/y;`);
  }
  if (indent?.rawBlock) {
    emit(`const LX_RB_SIG = new RegExp(${J(indent.rawBlock.signature ?? ':(?:[A-Za-z][A-Za-z0-9-]*)?[ \\t]*(?:\\r?\\n|$)')}, 'y');`);
  }
  if (tagScope) {
    emit(`const LX_TAG_BUILTINS = new Set(${J(tagScope.builtinHandles)});`);
    emit(`const LX_TAG_HANDLE = new RegExp(${J(tagScope.handlePattern)});`);
    emit(`const LX_TAG_DIRECTIVE = new RegExp(${J(tagScope.directiveHandlePattern)});`);
  }
  if (indent && plainContDecl) emit(`const LX_PLAIN_FLOW = new RegExp(${J(`^(?:${tokenPatternSource(plainContDecl)})`)});`);

  const kwFirstCcs = new Set([...st.kwLitKind.keys()].map(k => k.charCodeAt(0)));
  const canBeKw = (first: FirstSet) => !first || [...first.ascii].some(cc => kwFirstCcs.has(cc));   // keywords are ASCII-initial
  const kIdent = identTokenName ? kOf(identTokenName) : 0;
  const tRParen = tOf(')');
  const tLParen = tOf('(');
  emit(``);
  // ── Baked keyword recognizer over a SOURCE SPAN: t-intern with no slice and no hash.
  // Length window → first-charCode switch → per-keyword compare chains (shortest first);
  // returns exactly what LIT_KW.get(source.slice(a, b)) ?? 0 would.
  emit(`function lexKwT(source«: string», a«: number», b«: number») {`);
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
      emit(`    case ${c0}:`);
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
  // identTextValid: an identifier's `\u` escapes must decode to a well-formed IdentifierName.
  emit(`function lexIdentValid(text«: string», prefixLen«: number») {`);
  emit(`  const body = prefixLen > 0 ? text.slice(prefixLen) : text;`);
  emit(`  if (!body.includes('\\\\')) return true;`);
  emit(`  let bad = false;`);
  emit(`  const decoded = body.replace(LX_DECODE_ESC, (_m«: string», braced«: string», fixed«: string») => {`);
  emit(`    const cp = parseInt(braced ?? fixed, 16);`);
  emit(`    if (cp > 0x10FFFF) { bad = true; return ''; }`);
  emit(`    return String.fromCodePoint(cp);`);
  emit(`  });`);
  emit(`  if (bad) return false;`);
  emit(`  const m = decoded.match(LX_UNI_FULL);`);
  emit(`  return m !== null && m[0].length === decoded.length;`);
  emit(`}`);
  if (templateToken) {
    emit(`function lexTplSpan(source«: string», pos«: number», validateEscapes«: boolean») {`);
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
      emit(`          if (${recov}) { docLex.push({ offset: pos + lexSrcBase, end: pos + lexSrcBase + 1, kind: 1, ch: '' }); pos += 1; continue; }`);
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
    emit(`  if (${recov}) {`);
    emit(`    docLex.push({ offset: tplFrom + lexSrcBase, end: source.length + lexSrcBase, kind: 2, ch: '' });`);
    emit(`    return { endsWithInterp: false, end: source.length };`);
    emit(`  }`);
    emit(`  throw new Error('Unterminated template literal at offset ' + pos);`);
    emit(`}`);
  }
  if (indent) emitIndentHelpers(emit, indent, keyValueSep, compactIndicators, docMarkers);
  emit(``);
  emit(`function lexFull(source«: string») {`);
  emit(`  tokN = 0;`);
  if (windowed) emit(`  parenCachePos = -1;`);
  emit(`  srcLenP1 = source.length + 1;`);
  emit(`  negFrom = 0x7fffffff;`);
  emit(`  lexCore(source, 0, -1, 0, -1, 0, 0);`);
  emit(`  return tokN;`);
  emit(`}`);
  // Verification of the WINDOWED path (issue #45 B2): the golden gate exercises full lexes;
  // the windowed re-lex is checked at the tree level — incremental-verify / exhaustive-edits
  // compare an edited parse (whose tokens come from this windowed re-lex) to a FRESH FULL
  // parse of the same text, byte-identical.
  emit(`// The lexer core, parameterized for WINDOWED re-lexing: start at startPos with`);
  emit(`// the previous token's (k, t) as the regex-context seed (-1 = none / file start)`);
  emit(`// and EMPTY template/paren stacks (the caller restarts only at depth-0 safe`);
  emit(`// points). In window mode (wndPtr0 >= 0) the OLD stream sits in the alt buffers;`);
  emit(`// after each token pushed at/past wndMinOff, resync fires when it aligns with an`);
  emit(`// old token (same k/t, offsets shifted by wndDelta, both depth records 0) while`);
  emit(`// the window's own stacks are empty — returns that OLD index (the duplicate push`);
  emit(`// is retracted), or -1 when lexing ran to EOF.`);
  emit(`function lexCore(source«: string», startPos«: number», pvK«: number», pvT«: number», wndPtr0«: number», wndMinOff«: number», wndDelta«: number», wndCs«?: number», initParens«?: boolean[] | null», srcBase«?: number», hasMore«?: boolean») {`);
  emit(`  if (srcBase === undefined) srcBase = 0;`);
  emit(`  lexWindowMore = hasMore === true;`);
  emit(`  lexSrcBase = srcBase;`);
  emit(`  const n = source.length;`);
  emit(`  let pos = startPos;`);
  emit(`  let pendingNl = false;`);
  emit(`  let extraFl = 0;`);
  emit(`  let lastBangWasPostfix = false;`);
  emit(`  let lastCloseWasParenHead = false;`);
  emit(`  const templateStack«: number[]» = [];`);
  emit(`  const parenHeadStack«: boolean[]» = initParens !== undefined && initParens !== null ? initParens : [];`);
  if (resync) {
    emit(`  let wndPtr = wndPtr0;`);
    emit(`  let wndHit = -1;`);
    emit(`  // Trajectory minimums since the point the two lexes diverge (the damage start;`);
    emit(`  // before it, identical bytes from an identical anchor state give identical`);
    emit(`  // tokens and stack ops). An entry at depth <= BOTH mins was open at the`);
    emit(`  // divergence point in both lexes - i.e. it is the SAME entry.`);
    emit(`  let dmgMinOld = wndOldMin0, dmgMinNew = -1;`);
  }
  emit(`  lexEmptyPops.length = 0;`);
  if (lineSensitive) emit(`  let flowDepth = 0;               // >0 inside flow delimiters: line structure suspended`);
  if (indent) {
    emit(`  // line-boundary state: a comment was skipped / the outermost flow spanned >1 line /`);
    emit(`  // a multi-line flow just closed (stamped on the next token as flag bits 2 / 4)`);
    emit(`  let pendingComment = false;`);
    emit(`  let pendingMultilineFlow = false;`);
    emit(`  let flowSawNewline = false;`);
    emit(`  let lineStart = true;            // at a block-context line boundary (file start counts)`);
    emit(`  let emittedContent = false;      // a content token was emitted (suppresses a leading NEWLINE)`);
    emit(`  let atLineLead = false;          // the next content token is the first of its line`);
  }
  if (indent) {
    emit(`  let currentLineCol = 0;          // leading-space column of the current logical line`);
    emit(`  let lastExplicitKeyCol = -1;     // column of a line-lead \`?\` awaiting its \`:\` value half`);
    emit(`  const indentStack«: number[]» = [0];`);
    emit(`  let flowValueIndent = -1;        // §7.4: a value/item-position flow's enclosing block column`);
  }
  if (tagScope) {
    emit(`  const declaredHandles = new Set(LX_TAG_BUILTINS);`);
    emit(`  let pendingHandles = new Set«<string>»();`);
  }
  if (markup) {
    emit(`  let mode = 0;                    // 0 text, 1 tag, 2 raw text`);
    emit(`  let curTag = '';                 // tag name being read (decides raw-text entry)`);
    emit(`  let inTagName = false;           // the next tag-mode token is (part of) the tag name`);
    emit(`  let sawCloseMarker = false;      // this tag began with the close marker`);
    emit(`  let lowerSrc«: string | null» = null;`);
  }
  if (el) {
    emit(`  let tagAngle = 0;               // type-argument depth inside the current tag (\`<List<string>>\`)`);
    if (el.rawText?.length) emit(`  let lxTagAt«: number[]» = [];     // per element frame: the index of its current tag's tagOpen token`);
    emit(`  // A type-parameter signature being decided (\`<T>(x: T) => T\`): the group is lexed as code;`);
    emit(`  // the token after its closer keeps it (one of the signature's \`then\`) or rewinds to an element.`);
    emit(`  ${speculating ? 'specTok = -1; let' : 'let specTok = -1,'} specVerdict = 0, specClosedAt = -1, specParenBase = 0, specDocLex = 0, specPops = 0;`);
    emit(`  let specStack«: number[]» = [], specParens«: boolean[]» = [];`);
  }
  if (tracks) emit(`  let lxLookEnd = -1;              // the furthest unit (exclusive) a decision so far read past its token's end + 1`);
  // ── push ──
  emit(`  function tkPush(k«: number», t«: number», off«: number», end«: number») {`);
  // a token whose decision, or one before it, read past its end + 1 is no restart anchor (flag 32)
  if (tracks) emit(`    if (lxLookEnd > end + 1) extraFl |= 32;`);
  if (tagScope) emit(`    const rawOff = off, rawEnd = end;`);
  emit(`    off += srcBase«!»; end += srcBase«!»;`);
  emit(`    if (tokN === tkCap) growTok();`);
  emit(`    tkK[tokN] = k; tkT[tokN] = t; tkOff[tokN] = off; tkEnd[tokN] = end;`);
  if (indent) {
    emit(`    tkFl[tokN] = (pendingNl ? 1 : 0) | (pendingComment ? 2 : 0) | (pendingMultilineFlow ? 4 : 0) | extraFl;`);
    emit(`    pendingComment = false; pendingMultilineFlow = false;`);
  } else {
    emit(`    tkFl[tokN] = (pendingNl ? 1 : 0) | extraFl;`);
  }
  emit(`    extraFl = 0;`);
  if (el) {
    // the frame depth saturates (only a zero record is read: restart / resync points)
    // A token lexed while a signature is undecided (and the token deciding it) counts one level
    // deeper: its lexing depends on the `<` before it, so it is no restart or resync point. (A
    // type-parameter head veto is a read like a matcher's: `lxLookEnd`.)
    if (el.typeParameters?.signature) emit(`    { const d = templateStack.length + (specTok >= 0 ? 1 : 0); tkDp[tokN] = d > 255 ? 255 : d; }`);
    else emit(`    tkDp[tokN] = templateStack.length > 255 ? 255 : templateStack.length;`);
    if (el.typeParameters?.signature) {
      emit(`    if (specClosedAt >= 0 && tokN > specClosedAt) {`);
      emit(`      specClosedAt = -1;`);
      emit(`      if (k === K_PUNCT && LX_SIG_THEN[t] !== 0) specTok = -1; else specVerdict = 2;`);
      emit(`    }`);
    }
  } else {
    // the frame depth saturates: the record is a byte and only a zero is read (restart / resync
    // points), so a wrap at 256 nested holes would make a token inside them an anchor
    emit(`    tkDp[tokN] = templateStack.length > 255 ? 255 : templateStack.length;`);
  }
  emit(`    tkPd[tokN] = parenHeadStack.length;`);
  emit(`    pendingNl = false;`);
  emit(`    pvK = k; pvT = t;`);
  emit(`    tokN++;`);
  if (lineSensitive) {
    if (indent) emit(`    if (LX_STRUCT[k] === 0) { emittedContent = true; atLineLead = false; }`);
    emit(`    if (k === K_PUNCT) {`);
    emit(`      if (LX_FLOWOPEN[t] !== 0) {`);
    if (indent) {
      // Entering the OUTERMOST flow right after a `:` / `-` block indicator arms the §7.4
      // indent rule with the enclosing block column.
      emit(`        if (flowDepth === 0) {`);
      emit(`          flowValueIndent = tokN >= 2 && ${punctIs('tokN - 2', [keyValueSep, '-'])} ? indentStack[indentStack.length - 1] : -1;`);
      emit(`          flowSawNewline = false;`);
      emit(`        }`);
    }
    emit(`        flowDepth++;`);
    emit(`      } else if (LX_FLOWCLOSE[t] !== 0) {`);
    emit(`        flowDepth = flowDepth > 0 ? flowDepth - 1 : 0;`);
    if (indent) {
      emit(`        if (flowDepth === 0) {`);
      emit(`          flowValueIndent = -1;`);
      emit(`          if (flowSawNewline) pendingMultilineFlow = true;`);
      emit(`          flowSawNewline = false;`);
      emit(`        }`);
    }
    emit(`      }`);
    emit(`    }`);
  }
  if (tagScope) {
    // Tag-handle per-document membership: a directive stages its handle, `---` activates the
    // staged prologue, `...` resets to the builtins; a tag's named handle must be declared.
    const ks = (names: string[]) => { const v = names.map(n => st.typeKind.get(n)).filter((k): k is number => k !== undefined); return v.length ? v.map(k => `k === ${k}`).join(' || ') : 'false'; };
    emit(`    if (${ks(tagScope.directiveTokens)}) {`);
    emit(`      const m = LX_TAG_DIRECTIVE.exec(source.slice(rawOff, rawEnd));`);
    emit(`      if (m && m[1]) pendingHandles.add(m[1]);`);
    emit(`    } else if (${ks(tagScope.activateTokens)}) {`);
    emit(`      declaredHandles.clear();`);
    emit(`      for (const h of LX_TAG_BUILTINS) declaredHandles.add(h);`);
    emit(`      for (const h of pendingHandles) declaredHandles.add(h);`);
    emit(`      pendingHandles = new Set();`);
    emit(`    } else if (${ks(tagScope.resetTokens)}) {`);
    emit(`      declaredHandles.clear();`);
    emit(`      for (const h of LX_TAG_BUILTINS) declaredHandles.add(h);`);
    emit(`      pendingHandles = new Set();`);
    emit(`    } else if (${ks([tagScope.tagToken])}) {`);
    emit(`      const m = LX_TAG_HANDLE.exec(source.slice(rawOff, rawEnd));`);
    emit(`      const handle = m ? m[1] : null;`);
    emit(`      if (handle && !LX_TAG_BUILTINS.has(handle) && !declaredHandles.has(handle)) {`);
    emit(`        throw new Error("Undeclared tag handle '" + handle + "' at offset " + off);`);
    emit(`      }`);
    emit(`    }`);
  }
  if (resync) {
    emit(`    // Resync: adopt the OLD suffix from this aligned token on. Sound iff the old`);
    emit(`    // suffix's lexing is reproducible from OBSERVABLE state alone. Always required:`);
    emit(`    //  - both template stacks EMPTY (an entry's brace counter is mutable state no`);
    emit(`    //    record captures - depth equality cannot prove counters equal);`);
    emit(`    //  - the candidate carries no cross-token flag its adopted successor reads`);
    emit(`    //    (postfix-ambiguous op / control keyword / '(' / ')' each make the NEXT`);
    emit(`    //    token's lexing depend on tokens BEFORE the candidate).`);
    emit(`    // Then either of two sufficient paren-stack conditions:`);
    emit(`    //  - FAST: equal depth, never dipped below it since the divergence point on`);
    emit(`    //    either side - the stacks are content-EQUAL; or`);
    emit(`    //  - SHIFTED: the old suffix never pops an entry that is open at the candidate`);
    emit(`    //    (suffix min depth >= candidate depth, a pop-on-empty counted as -1): the`);
    emit(`    //    caller re-bases the adopted tkPd column by lexResyncPd.`);
    emit(`    if (wndPtr >= 0) {`);
    emit(`      const pd = tkPd[tokN - 1], pd0 = lxPdBefore(k, t, pd);`);
    emit(`      if (dmgMinNew < 0) { if (off >= wndCs«!») dmgMinNew = pd0; }`);
    emit(`      else if (pd0 < dmgMinNew) dmgMinNew = pd0;`);
    emit(`      if (off >= wndMinOff) {`);
    emit(`        while (wndPtr < altN && (altOff«!»[wndPtr] < 0 ? altOff«!»[wndPtr] + srcLenP1 : altOff«!»[wndPtr]) + wndDelta < off) { const q0 = lxPdBefore(altK«!»[wndPtr], altT«!»[wndPtr], altPd«!»[wndPtr]); if (q0 < dmgMinOld) dmgMinOld = q0; wndPtr++; }`);
    emit(`        if (wndPtr < altN && (altOff«!»[wndPtr] < 0 ? altOff«!»[wndPtr] + srcLenP1 : altOff«!»[wndPtr]) + wndDelta === off && altK«!»[wndPtr] === k && altT«!»[wndPtr] === t`);
    emit(`            && (altEnd«!»[wndPtr] < 0 ? altEnd«!»[wndPtr] + srcLenP1 : altEnd«!»[wndPtr]) + wndDelta === end`);
    emit(`            // the candidate's LEADING-TRIVIA flags must match too (parsers read them)`);
    emit(`            && altFl«!»[wndPtr] === tkFl[tokN - 1]`);
    emit(`            && templateStack.length === 0 && altDp«!»[wndPtr] === 0${el?.typeParameters?.signature ? ' && specTok < 0' : ''}`);
    // outside every read past a token's end + 1: the adopted tokens' flag 32 is then a fresh lex's
    if (tracks) emit(`            && (tkFl[tokN - 1] & 32) === 0`);
    emit(`            && LX_PFXV[t] === 0 && LX_PARENKW[t] === 0 && LX_EXPRKW[t] === 0`);
    emit(`            && !(k === K_PUNCT && (t === ${tLParen} || t === ${tRParen}))) {`);
    emit(`          const q = altPd«!»[wndPtr];`);
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
    emit(`              okTail = altSuffMin«!»[wndPtr + 1] >= q;`);
    emit(`            }`);
    emit(`            if (okTail) {`);
    emit(`              wndHit = wndPtr;`);
    emit(`              lexResyncPd = pd - q;`);
    emit(`            }`);
    emit(`          }`);
    emit(`        }`);
    emit(`      }`);
    emit(`    }`);
  }
  emit(`  }`);
  emit(`  // prevIsValue, baked: postfix-ambiguous op → its recorded position; an expression-`);
  emit(`  // head keyword or a control-head ')' is NOT a value; else division-prev type/text.`);
  emit(`  function prevIsValue() {`);
  if (el) {
    // inside a tag nothing is a regex; the token that ends an element entered from code is a value
    emit(`    if (templateStack.length > 0 && (templateStack[templateStack.length - 1] & 3) === 2 && (templateStack[templateStack.length - 1] & 12) !== 0${dirs ? ' && (templateStack[templateStack.length - 1] & 12) !== 12' : ''}) return true;`);
    emit(`    if (tokN > 0 && (tkFl[tokN - 1] & 16) !== 0) return true;`);
  }
  emit(`    const k = tokN > 0 ? tkK[tokN - 1] : pvK;`);
  emit(`    if (k < 0) return false;`);
  emit(`    const t = tokN > 0 ? tkT[tokN - 1] : pvT;`);
  emit(`    if (LX_PFXV[t] !== 0) return lastBangWasPostfix;`);
  // an expression-head keyword heads an expression, except as a member name (`a.new / 2`)
  emit(`    if (k === ${kIdent} && LX_EXPRKW[t] !== 0 && !(tokN >= 2 && LX_MEMBER[tkT[tokN - 2]] !== 0)) return false;`);
  emit(`    if (t === ${tRParen} && lastCloseWasParenHead) return false;`);
  emit(`    return LX_DIVK[k] !== 0 || LX_DIVT[t] !== 0;`);
  emit(`  }`);
  // the children's text tokens (ElementRegion.textTokens): each is an ordinary scan matcher, tried
  // first in the children; `after` bounds where it may stop a run
  const textTokens: TextTokenPlan[] = (el?.textTokens ?? []).map(({ token, after }) => {
    if (el!.text === undefined) throw new Error('elements.textTokens: needs a text token (elements.text)');
    const m = matchers.find(x => x.name === token);
    if (!m) throw new Error(`elements.textTokens: no scanned token named '${token}'`);
    if (after !== undefined && !oneChar(after)) throw new Error(`elements.textTokens: '${token}'.after must be a one-unit class`);
    return { re: m.re, k: m.k, skip: m.skip, readEnd: m.readEnd, overEnd: m.overEnd, pattern: m.tokenPattern, first: patternInfo(m.tokenPattern).first, after: after === undefined ? null : patternInfo(after).first };
  });
  const dirCtx = dirs ? {
    // the identifier's units: a word literal must not run on into one (\`@iffy\`)
    idCont: patternInfo(spec.tokens.find(t => t.identifier)?.pattern ?? '').chars,
    skips: matchers.filter(m => m.skip).map(m => ({ re: m.re, first: patternInfo(m.tokenPattern).first, readEnd: m.readEnd })),
    looks,
  } : null;
  if (el) emitElementHelpers(emit, el, enterAlways, { kOf, puT, startsWithExpr, J, headOverEnd, textTokens, dirs, dirCtx });
  if (markup) {
    // Tag-mode tracking after a token the scan emitted: the closing `tagClose` enters raw text
    // (a raw-text element) or text; the tag name decides raw-text entry and void retagging.
    emit(`  function lxOpensTag(i«: number») {`);
    emit(markup.tagOpenAfter
      ? `    return i + ${markup.tagOpen.length} < n && LX_TAG_OPEN_AFTER.test(source[i + ${markup.tagOpen.length}]);`
      : `    return true;`);
    emit(`  }`);
    emit(`  function lxTagTrack() {`);
    emit(`    if (tokN === 0) return;`);
    emit(`    const li = tokN - 1;`);
    emit(`    if (${textIs('li', markup.tagClose)}) {`);
    emit(`      const isRaw = !sawCloseMarker && LX_RAW_TAGS.has(curTag.toLowerCase());`);
    emit(`      mode = isRaw ? 2 : 0;`);
    if (markup.closeMarker) {
      // A raw-text element is never self-closing: drop a `/` right before its `>`.
      emit(`      if (isRaw && li > 0 && tkK[li - 1] === K_PUNCT && ${textIs('li - 1', markup.closeMarker)}) {`);
      emit(`        tkK[li - 1] = tkK[li]; tkT[li - 1] = tkT[li]; tkOff[li - 1] = tkOff[li]; tkEnd[li - 1] = tkEnd[li];`);
      emit(`        tkFl[li - 1] = tkFl[li]; tkDp[li - 1] = tkDp[li]; tkPd[li - 1] = tkPd[li];`);
      emit(`        tokN--;`);
      emit(`      }`);
    }
    emit(`      inTagName = false; sawCloseMarker = false;`);
    emit(`    } else if (inTagName) {`);
    if (markup.closeMarker) emit(`      if (${textIs('li', markup.closeMarker)}) sawCloseMarker = true; else {`);
    else emit(`      {`);
    emit(`        curTag = source.slice(tkOff[li] - lexSrcBase, tkEnd[li] - lexSrcBase); inTagName = false;`);
    if (markup.voidNameToken) emit(`        if (!sawCloseMarker && LX_VOID_TAGS.has(curTag.toLowerCase())) tkK[li] = ${kOf(markup.voidNameToken)};`);
    emit(`      }`);
    emit(`    }`);
    emit(`  }`);
  }
  const CONT = markup ? `{ lxTagTrack(); continue; }` : `continue;`;
  if (speculating) {
    // a lex error while deciding a type-parameter signature decides it: the head was an element
    emit(`  for (;;) {`);
    emit(`  try {`);
    emit(`  while (true) {`);
  } else emit(`  while (pos < n) {`);
  if (resync) {
    emit(`    // resync retracts the duplicated token push — and any lexer diagnostics`);
    emit(`    // emitted FOR it (the old stream's persisted entry survives via the shift)`);
    emit(resyncRetractLine('    '));
  }
  if (speculating) {
    emit(`    if (specTok >= 0 && (specVerdict === 2 || pos >= n)) lxSpecRewind();`);
    emit(`    if (pos >= n) break;`);
  }
  emit(`    const cc = source.charCodeAt(pos);`);
  if (el) emitElementFrame(emit, el, { kOf, puT, tOf, startsWithExpr, punctIs, textTokens, dirs });
  if (markup) {
    emit(`    // ── markup TEXT mode: a comment, a tag open, or the text run up to the next real tag open ──`);
    emit(`    if (mode === 0) {`);
    if (markup.comment) {
      const c = markup.comment;
      emit(`      if (${startsWithExpr('source', 'pos', c.open, 'cc')}) {`);
      emit(`        const idx = source.indexOf(${J(c.close)}, pos + ${c.open.length});`);
      emit(`        const end = idx < 0 ? n : idx + ${c.close.length};`);
      emit(`        tkPush(${kOf(c.token)}, lexKwT(source, pos, end), pos, end);`);
      emit(`        pos = end;`);
      emit(`        continue;`);
      emit(`      }`);
    }
    emit(`      if (${startsWithExpr('source', 'pos', markup.tagOpen, 'cc')} && lxOpensTag(pos)) {`);
    emit(`        tkPush(K_PUNCT, ${puT(markup.tagOpen)}, pos, pos + ${markup.tagOpen.length});`);
    emit(`        pos += ${markup.tagOpen.length};`);
    emit(`        mode = 1; inTagName = true; sawCloseMarker = false; curTag = '';`);
    emit(`        continue;`);
    emit(`      }`);
    emit(`      let p = source.indexOf(${J(markup.tagOpen)}, pos);`);
    emit(`      while (p >= 0 && !lxOpensTag(p)) p = source.indexOf(${J(markup.tagOpen)}, p + 1);`);
    emit(`      if (p < 0) p = n;`);
    emit(`      tkPush(${kOf(markup.textToken)}, lexKwT(source, pos, p), pos, p);`);
    emit(`      pos = p;`);
    emit(`      continue;`);
    emit(`    }`);
    if (markup.rawText) {
      emit(`    // ── markup RAW-TEXT mode: verbatim content up to the matching close tag ──`);
      emit(`    if (mode === 2) {`);
      emit(`      const needle = (${J(markup.tagOpen + (markup.closeMarker ?? ''))} + curTag).toLowerCase();`);
      emit(`      if (lowerSrc === null) lowerSrc = source.toLowerCase();`);
      emit(`      const idx = lowerSrc.indexOf(needle, pos);`);
      emit(`      const end = idx < 0 ? n : idx;`);
      emit(`      if (end > pos) tkPush(${kOf(markup.rawText.token)}, lexKwT(source, pos, end), pos, end);`);
      emit(`      pos = end;`);
      emit(`      mode = 0; curTag = '';`);
      emit(`      continue;`);
      emit(`    }`);
    }
  }
  if (indent) emitLineStart(emit, indent, lineComment, kOf, plainContName);
  // ── whitespace ──
  if (lineSensitive) {
    emit(`    // inline spaces/tabs are skipped; a newline is a block-context line boundary (flow: insignificant)`);
    emit(`    if (cc === 32 || cc === 9) {`);
    if (indent) {
      // A TAB between a block indicator and the nested block-structural node it introduces is
      // the nested node's indentation (§6.1).
      const indicatorLits = [...compactIndicators, keyValueSep];
      emit(`      if (flowDepth === 0 && tokN > 0 && ${punctIs('tokN - 1', indicatorLits)}) {`);
      emit(`        let q = pos; while (q < n && (source.charCodeAt(q) === 32 || source.charCodeAt(q) === 9)) q++;`);
      emit(`        if (source.slice(pos, q).includes('\\t') && lxStartsBlock(source, q, tkT[tokN - 1] !== ${puT(keyValueSep)})) {`);
      emit(`          throw new Error('Tab character used in indentation at offset ' + pos);`);
      emit(`        }`);
      emit(`      }`);
    }
    emit(`      pos++; continue;`);
    emit(`    }`);
    emit(`    if (cc === 10 || cc === 13) {`);
    if (!indent) {
      emit(`      const s = pos;`);
      emit(`      pos++; if (cc === 13 && source.charCodeAt(pos) === 10) pos++;`);
      emit(`      if (flowDepth === 0) tkPush(${kOf(newline!.token)}, 0, s, pos);`);
      emit(`      pendingNl = true;`);
      emit(`      continue;`);
      emit(`    }`);
    } else {
      emit(`      pos++; if (cc === 13 && source.charCodeAt(pos) === 10) pos++;`);
      emit(`      if (flowDepth === 0) lineStart = true;`);
      emit(`      else {`);
      emit(`        flowSawNewline = true;`);
      emit(`        // §7.4: inside a value/item-position flow a CONTENT line must be indented more`);
      emit(`        // than the enclosing block column (blank / comment / closer lines exempt)`);
      emit(`        if (flowValueIndent >= 0) {`);
      emit(`          let col = 0; while (source.charCodeAt(pos + col) === 32) col++;`);
      emit(`          let q = pos + col; while (source.charCodeAt(q) === 32 || source.charCodeAt(q) === 9) q++;`);
      emit(`          const fc = source.charCodeAt(q);`);
      emit(`          const blank = q >= n || fc === 10 || fc === 13;`);
      emit(`          const isComment = ${indentComment !== undefined ? startsWithExpr('source', 'q', indentComment) : 'false'};`);
      emit(`          const isClose = q < n && ${ccIn('fc', flowClose)};`);
      emit(`          if (!blank && !isComment && !isClose && col <= flowValueIndent) {`);
      emit(`            throw new Error('Flow collection line is not sufficiently indented at offset ' + q);`);
      emit(`          }`);
      emit(`        }`);
      emit(`      }`);
      emit(`      continue;`);
      emit(`    }`);
    }
  } else {
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
  }
  if (indent?.blockScalar) emitBlockScalar(emit, indent, kOf(indent.blockScalar.token));
  if (indent?.rawBlock) emitRawBlock(emit, indent, kOf(indent.rawBlock.token));
  if (el) {
    // an element hole: its closer at brace count 0 ends it (the token is pushed inside the frame)
    emit(`    if (templateStack.length > 0 && (templateStack[templateStack.length - 1] & 3) === 1) {`);
    emit(`      const fv = templateStack[templateStack.length - 1];`);
    emit(`      if (${startsWithExpr('source', 'pos', el.hole.close, 'cc')}) {`);
    emit(`        if (fv === 1) {`);
    emit(`          tkPush(K_PUNCT, ${tOf(el.hole.close)}, pos, pos + ${el.hole.close.length});`);
    emit(`          pos += ${el.hole.close.length};`);
    emit(`          templateStack.pop();`);
    emit(`          continue;`);
    emit(`        }`);
    emit(`        templateStack[templateStack.length - 1] = fv - 4;`);
    emit(`      } else if (${startsWithExpr('source', 'pos', el.hole.open, 'cc')}) {`);
    emit(`        templateStack[templateStack.length - 1] = fv + 4;`);
    emit(`      }`);
    emit(`    }`);
  }
  if (templateToken) {
    const tplCloseT = kwFirstCcs.has(tplInterpClose.charCodeAt(0)) ? 'lexKwT(source, startPos, r.end)' : '0';
    const tplOpenT = kwFirstCcs.has(tplOpen.charCodeAt(0)) ? 'lexKwT(source, startPos, r.end)' : '0';
    emit(el ? `    if (templateStack.length > 0 && (templateStack[templateStack.length - 1] & 3) === 0) {` : `    if (templateStack.length > 0) {`);
    emit(`      if (${startsWithExpr('source', 'pos', tplInterpClose, 'cc')}) {`);
    emit(`        const depth = templateStack[templateStack.length - 1];`);
    emit(`        if (depth === 0) {`);
    // A token that opens or continues a hole is recorded INSIDE its frame (the frame is on the
    // stack at its push); only the tail, which closes it, is recorded outside. A window
    // re-lex restarts and resyncs at depth-0 tokens only, so it never starts inside a hole.
    emit(`          const startPos = pos;`);
    emit(`          const r = lexTplSpan(source, pos + ${tplInterpClose.length}, false);`);
    emit(`          if (r.endsWithInterp) {`);
    emit(`            tkPush(${kOf('$templateMiddle')}, ${tplCloseT}, startPos, r.end);`);
    emit(`          } else {`);
    emit(`            templateStack.pop();`);
    emit(`            tkPush(${kOf('$templateTail')}, ${tplCloseT}, startPos, r.end);`);
    emit(`          }`);
    emit(`          pos = r.end;`);
    emit(`          continue;`);
    emit(`        }`);
    emit(el ? `        templateStack[templateStack.length - 1] = depth - 4;` : `        templateStack[templateStack.length - 1] = depth - 1;`);
    emit(`      } else if (cc === ${tplBraceOpen.charCodeAt(0)}) {`);
    emit(el ? `        templateStack[templateStack.length - 1] += 4;` : `        templateStack[templateStack.length - 1]++;`);
    emit(`      }`);
    emit(`    }`);
    emit(`    if (${startsWithExpr('source', 'pos', tplOpen, 'cc')}) {`);
    emit(`      const tagged = prevIsValue();`);
    emit(`      const startPos = pos;`);
    emit(`      const r = lexTplSpan(source, pos + ${tplOpen.length}, !tagged);`);
    emit(`      if (r.endsWithInterp) {`);
    emit(`        templateStack.push(0);`);
    emit(`        tkPush(${kOf('$templateHead')}, ${tplOpenT}, startPos, r.end);`);
    emit(`      } else {`);
    emit(`        tkPush(${kOf(templateToken.name)}, ${tplOpenT}, startPos, r.end);`);
    emit(`      }`);
    emit(`      pos = r.end;`);
    emit(`      continue;`);
    emit(`    }`);
  }
  if (markup?.unquotedValueToken && markup.attributeAssign) {
    emit(`    // markup unquoted attribute value: right after the assign char, scan the whole value`);
    emit(`    if (tokN > 0 && ${textIs('tokN - 1', markup.attributeAssign)} && !${ccIn('cc', markup.attributeQuotes ?? ['"', "'"])}) {`);
    emit(`      LX_UNQUOTED.lastIndex = pos;`);
    emit(`      const vm = LX_UNQUOTED.exec(source);`);
    emit(`      if (vm !== null) {`);
    emit(`        const _e = pos + vm[0].length;`);
    emit(`        tkPush(${kOf(markup.unquotedValueToken)}, lexKwT(source, pos, _e), pos, _e);`);
    emit(`        pos = _e;`);
    emit(`        continue;`);
    emit(`      }`);
    emit(`    }`);
  }
  if (indent && (indent.flowSeparatorAfterTokens ?? []).length) {
    emit(`    // flow \`key: value\` separator glued to a quoted key or a flow close`);
    emit(`    if (flowDepth > 0 && tokN > 0 && ${startsWithExpr('source', 'pos', keyValueSep, 'cc')}`);
    emit(`        && (LX_FLOWSEP[tkK[tokN - 1]] !== 0 || (tkK[tokN - 1] === K_PUNCT && LX_FLOWCLOSE[tkT[tokN - 1]] !== 0))) {`);
    emit(`      tkPush(K_PUNCT, ${puT(keyValueSep)}, pos, pos + ${keyValueSep.length});`);
    emit(`      pos += ${keyValueSep.length};`);
    emit(`      continue;`);
    emit(`    }`);
  }

  // ── The per-charCode dispatch switch: matcher candidates (declaration order) then
  // the punct compare-chain, identical action lists clustered into one case group. ──
  // A matcher's variant at a cc: in block context (flowDepth 0) its block regex when it has one;
  // in flow its plain regex unless block-only. A grammar without line structure is always at
  // flowDepth 0.
  const admitsF = (f: FirstSet, cc: number) => !f || (cc > 127 ? f.nonAscii : f.ascii.has(cc));
  const variantAt = (m: M, cc: number, inFlow: boolean): 'R' | 'B' | null => {
    if (!inFlow) return m.blockRe ? (admitsF(m.blockFirst, cc) ? 'B' : null) : (admitsF(m.first, cc) ? 'R' : null);
    return m.blockOnly ? null : (admitsF(m.first, cc) ? 'R' : null);
  };
  type Act = { m: M; v0: 'R' | 'B' | null; v1: 'R' | 'B' | null };
  const actsAt = (cc: number): Act[] => matchers
    .map(m => ({ m, v0: variantAt(m, cc, false), v1: lineSensitive ? variantAt(m, cc, true) : variantAt(m, cc, false) }))
    .filter(a => a.v0 !== null || a.v1 !== null);
  const needsLabel = !!indentComment;
  const fastOk = (cc: number, acts: Act[]) => {
    if (acts.length === 0) return false;
    const a = acts[0], m = a.m;
    return a.v0 === 'R' && a.v1 === 'R' && m.loop !== null && !m.skip && !m.isRegex && m.loop.first.includes(cc)
      && !(m.isString && indent?.blockScalar) && !(indentComment && cc === indentComment.charCodeAt(0));
  };
  const caseCcs = new Set<number>();
  for (let cc = 0; cc < 128; cc++) caseCcs.add(cc);
  for (const cc of punctByFirstCc.keys()) caseCcs.add(cc);
  const groups = new Map<string, { ccs: number[]; acts: Act[]; ps: string[]; fast: boolean }>();
  for (const cc of [...caseCcs].sort((a, b) => a - b)) {
    const acts = actsAt(cc);
    const ps = punctByFirstCc.get(cc) ?? [];
    if (acts.length === 0 && ps.length === 0) continue;
    const fast = fastOk(cc, acts);
    const sig = acts.map(a => `${a.m.name}:${a.v0}:${a.v1}`).join(',') + '|' + ps.join('\u0000') + (fast ? '|F' : '');
    if (!groups.has(sig)) groups.set(sig, { ccs: [], acts, ps, fast });
    groups.get(sig)!.ccs.push(cc);
  }

  // `ccs`: the first units of the dispatch arm (null: beyond ASCII), which bound a failed attempt's read
  const emitMatcherTry = (m: M, re: string, ind: string, ccs: number[] | null) => {
    emit(`${ind}${re}.lastIndex = pos;`);
    emit(`${ind}{ const m = ${re}.exec(source);`);
    emit(`${ind}  if (m !== null) {`);
    const i2 = ind + '    ';
    if (m.isString && indent?.blockScalar) {
      emit(`${i2}if (m[0].includes('\\n')) {`);
      // A col-0 document marker inside a multi-line quoted scalar is a document boundary:
      // truncate the match just before that line.
      emit(`${i2}  let cut = -1;`);
      emit(`${i2}  for (let k = 0; k < m[0].length; k++) if (m[0].charCodeAt(k) === 10 && lxMarkerAt(source, pos + k + 1)) { cut = k; break; }`);
      emit(`${i2}  if (cut >= 0) {`);
      emit(`${i2}    tkPush(${m.k}, lexKwT(source, pos, pos + cut), pos, pos + cut);`);
      emit(`${i2}    pos += cut;`);
      emit(`${i2}    ${CONT}`);
      emit(`${i2}  }`);
      // Each non-blank continuation line must be indented more than the scalar's parent node.
      emit(`${i2}  if (flowDepth === 0) {`);
      emit(`${i2}    const pi = tokN - 1;`);
      emit(`${i2}    const prevIsDocMarker = pi >= 0 && (${docMarkers.length ? docMarkers.map(mk => textIs('pi', mk)).join(' || ') : 'false'});`);
      emit(`${i2}    const parentCol = atLineLead ? (indentStack.length > 1 ? indentStack[indentStack.length - 2] : -1) : prevIsDocMarker ? -1 : currentLineCol;`);
      emit(`${i2}    const s = m[0];`);
      emit(`${i2}    let bad = -1;`);
      emit(`${i2}    for (let k = 0; k < s.length; k++) {`);
      emit(`${i2}      if (s.charCodeAt(k) !== 10) continue;`);
      emit(`${i2}      let e = k + 1; while (e < s.length && s.charCodeAt(e) !== 10) e++;`);
      emit(`${i2}      const line = s.slice(k + 1, e);`);
      emit(`${i2}      if (line.trim() === '') continue;`);
      emit(`${i2}      const sp = line.length - line.replace(/^ +/, '').length;`);
      emit(`${i2}      if (sp <= parentCol) { bad = pos + k + 1; break; }`);
      emit(`${i2}    }`);
      emit(`${i2}    if (bad >= 0) throw new Error('Multi-line quoted scalar continuation is not sufficiently indented at offset ' + bad);`);
      emit(`${i2}  }`);
      emit(`${i2}}`);
    }
    if (indentComment) {
      // A comment indicator opens a comment only at line start or after whitespace (§6.6):
      // a glued one refuses the match (falls through to the punct chain).
      emit(`${i2}if (m[0].startsWith(${J(indentComment)}) && pos > 0) { const b = source.charCodeAt(pos - 1); if (b !== 32 && b !== 9 && b !== 10 && b !== 13) break mt; }`);
    }
    if (m.identLike) {
      const plen = (identPrefixByName.get(m.name) ?? '').length;
      emit(`${i2}if (!lexIdentValid(m[0], ${plen})) {`);
      emit(`${i2}  if (lexWindowMore) throw LEX_RETRY;`);
      emit(`${i2}  if (!${recov}) throw new Error("Invalid identifier escape at offset " + pos + ": '" + m[0] + "'");`);
      emit(`${i2}  docLex.push({ offset: pos + lexSrcBase, end: pos + lexSrcBase + m[0].length, kind: 3, ch: m[0] });`);
      emit(`${i2}}`);
    }
    if (m.overEnd) emit(`${i2}{ const e = pos + m[0].length; if (e < n) { const c = source.charCodeAt(e); if (${unitIn('c', overTrigger(m.tokenPattern))}) { const r = ${m.overEnd}(source, e); if (r > lxLookEnd) lxLookEnd = r; } } }`);
    if (m.skip) {
      emit(`${i2}if (/[\\n\\r\\u2028\\u2029]/.test(m[0])) pendingNl = true;`);
      if (indentComment) emit(`${i2}if (m[0].startsWith(${J(indentComment)})) pendingComment = true;`);
      emit(`${i2}pos += m[0].length;`);
    } else {
      const first = re === m.blockRe ? m.blockFirst : m.first;
      emit(`${i2}const _e = pos + m[0].length;`);
      emit(`${i2}tkPush(${m.k}, ${canBeKw(first) ? 'lexKwT(source, pos, _e)' : '0'}, pos, _e);`);
      emit(`${i2}pos = _e;`);
    }
    emit(`${i2}${CONT}`);
    // a failed attempt from this arm's first units that can read past the end + 1 of the token decided after it
    const recFail = m.readEnd !== null && (ccs === null ? failRead(m.tokenPattern) : Math.max(...ccs.map(c => failReadFirst(m.tokenPattern, c)))) > FREE_FAIL;
    // ... and only when the unit after the first is one after which it can read on (continuesAt)
    const cont = recFail && ccs !== null ? unitIn('c1', ccs.reduce<CSet>((a, c) => union(a, continuesAt(m.tokenPattern, c)), [])) : 'true';
    emit(!recFail || cont === 'false' ? `${ind}  } }`
      : cont === 'true' ? `${ind}  } else { const r = ${m.readEnd}(source, pos); if (r > lxLookEnd) lxLookEnd = r; } }`
      : `${ind}  } else if (pos + 1 < n) { const c1 = source.charCodeAt(pos + 1); if (${cont}) { const r = ${m.readEnd}(source, pos); if (r > lxLookEnd) lxLookEnd = r; } } }`);
  };
  const emitAct = (a: Act, ind: string, ccs: number[] | null) => {
    const reOf = (v: 'R' | 'B') => (v === 'B' ? a.m.blockRe! : a.m.re);
    const body = (v: 'R' | 'B', i: string) => {
      if (a.m.isRegex) {
        emit(`${i}if (!prevIsValue()) {`);
        emitMatcherTry(a.m, reOf(v), i + '  ', ccs);
        emit(`${i}}`);
      } else emitMatcherTry(a.m, reOf(v), i, ccs);
    };
    if (a.v0 === a.v1) { body(a.v0!, ind); return; }
    if (a.v0 && a.v1) {
      emit(`${ind}if (flowDepth === 0) {`); body(a.v0, ind + '  ');
      emit(`${ind}} else {`); body(a.v1, ind + '  ');
      emit(`${ind}}`);
    } else if (a.v0) {
      emit(`${ind}if (flowDepth === 0) {`); body(a.v0, ind + '  '); emit(`${ind}}`);
    } else {
      emit(`${ind}if (flowDepth !== 0) {`); body(a.v1!, ind + '  '); emit(`${ind}}`);
    }
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
      emit(`${ind}else lastCloseWasParenHead = parenHeadStack.pop()«!»;`);
      if (el?.typeParameters?.signature) emit(`${ind}if (specTok >= 0 && tokN > specTok + 3 && parenHeadStack.length === specParenBase) specClosedAt = tokN;`);
    }
    if (regexCtx?.postfixAfterValueTexts?.includes(lit)) {
      emit(`${ind}lastBangWasPostfix = prevIsValue();`);
    }
    const isKv = !!indent && lit === keyValueSep;
    const isCompact = !!indent && compactIndicators.includes(lit);
    const isQ = !!indent && lit === '?';
    if (isKv || isCompact || isQ) emit(`${ind}const wasLineLead = atLineLead;`);
    if (isQ) emit(`${ind}if (flowDepth === 0 && wasLineLead) lastExplicitKeyCol = currentLineCol;`);
    emit(`${ind}tkPush(K_PUNCT, ${tOf(lit)}, pos, pos + ${lit.length});`);
    emit(`${ind}pos += ${lit.length};`);
    if (isKv) {
      // The explicit-value half of a line-lead `? key` (same column) whose value is a `-`
      // sequence on the same line gets the compact push; the pairing is used up once.
      emit(`${ind}const colonPairsExplicit = wasLineLead && currentLineCol === lastExplicitKeyCol;`);
      emit(`${ind}const compactColon = colonPairsExplicit && lxDashAfter(source, pos);`);
      emit(`${ind}if (colonPairsExplicit) lastExplicitKeyCol = -1;`);
    }
    if (isKv || isCompact) {
      // Compact notation: a line-lead indicator whose nested node begins inline with block-
      // structural content nests at that content's column (push + INDENT).
      const conds = [isKv ? 'compactColon' : '', isCompact ? 'wasLineLead' : ''].filter(Boolean).join(' || ');
      emit(`${ind}if (flowDepth === 0 && (${conds})) {`);
      emit(`${ind}  let q = pos; while (q < n && source.charCodeAt(q) === 32) q++;`);
      emit(`${ind}  const contentCol = currentLineCol + (q - (pos - ${lit.length}));`);
      emit(`${ind}  const c = source.charCodeAt(q);`);
      emit(`${ind}  if (q > pos && q < n && c !== 10 && c !== 13${indentComment !== undefined ? ` && !(${startsWithExpr('source', 'q', indentComment)})` : ''}`);
      emit(`${ind}      && contentCol > indentStack[indentStack.length - 1] && lxCompactNests(source, q)) {`);
      emit(`${ind}    indentStack.push(contentCol);`);
      emit(`${ind}    tkPush(${kOf(indent!.indentToken)}, 0, q, q);`);
      emit(`${ind}    atLineLead = true;`);
      emit(`${ind}  }`);
      emit(`${ind}}`);
    }
    emit(`${ind}${CONT}`);
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
        emit(`${ind}{`);
        emitPunct(lit, ind + '  ');
        emit(`${ind}}`);
      }
    }
  };

  // Range-condensed charCode condition over a sorted code list, hottest-first
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

  if (el) {
    // an element entered from code, outside a tag: every tagOpen (the grammar uses it only to
    // open tags), or else one where an operand may start (the regex-literal position) unless it
    // begins a type-parameter list
    emit(`    if (${startsWithExpr('source', 'pos', el.tagOpen, 'cc')}${el.tagStart !== undefined ? ` && lxTagStart(source, pos + ${el.tagOpen.length})` : ''} && (templateStack.length === 0 || (templateStack[templateStack.length - 1] & 3) !== 2)${speculating ? ' && specTok < 0' : ''}${enterAlways ? '' : ' && !prevIsValue() && lxOpensElement(pos)'}) {`);
    emit(`      templateStack.push(6);`);
    if (el.rawText?.length) emit(`      lxTagAt[templateStack.length - 1] = tokN;`);
    emit(`      tkPush(K_PUNCT, ${puT(el.tagOpen)}, pos, pos + ${el.tagOpen.length});`);
    emit(`      pos += ${el.tagOpen.length};`);
    emit(`      tagAngle = 0;`);
    emit(`      continue;`);
    emit(`    }`);
  }
  emit(`    switch (cc) {`);
  for (const g of groups.values()) {
    emit(`      ${g.ccs.map(c => `case ${c}:`).join(' ')} {`);
    if (g.fast) {
      // Char-loop fast path: consume the plain continuation class; a bail stop char
      // (escape opener) falls through to the regex try below, which re-scans from pos.
      const m0 = g.acts[0].m;
      const lp = m0.loop!;
      const bails = lp.bail.map(c => `c === ${c}`);
      if (lp.bailNonAscii) bails.push(`c > 127`);
      emit(`        let p = pos + 1;`);
      emit(`        let c = source.charCodeAt(p);`);
      emit(`        while (${ccCond('c', lp.cont)}) { p++; c = source.charCodeAt(p); }`);
      if (bails.length === 0) {
        // nothing stops the loop short: the token is always taken, the rest is unreachable
        emit(`        tkPush(${m0.k}, ${canBeKw(m0.first) ? 'lexKwT(source, pos, p)' : '0'}, pos, p);`);
        emit(`        pos = p;`);
        emit(`        ${CONT}`);
        emit(`      }`);
        continue;
      }
      emit(`        if (!(${bails.join(' || ')})) {`);
      emit(`          tkPush(${m0.k}, ${canBeKw(m0.first) ? 'lexKwT(source, pos, p)' : '0'}, pos, p);`);
      emit(`          pos = p;`);
      emit(`          ${CONT}`);
      emit(`        }`);
    }
    if (needsLabel && g.acts.length > 0) {
      emit(`        mt: {`);
      for (const a of g.acts) emitAct(a, '          ', g.ccs);
      emit(`        }`);
    } else {
      for (const a of g.acts) emitAct(a, '        ', g.ccs);
    }
    emitPunctChain(g.ps, '        ');
    emit(`        break;`);
    emit(`      }`);
  }
  // Any other char: only a matcher whose first-char set admits non-ASCII can start here
  // (an unproven set admits every ASCII char, so those all took a case above).
  const defaultActs = actsAt(0x10000);
  emit(`      default: {`);
  if (defaultActs.length > 0) {
    emit(`        if (cc > 127) {`);
    if (needsLabel) emit(`        mt: {`);
    for (const a of defaultActs) emitAct(a, '          ', null);
    if (needsLabel) emit(`        }`);
    emit(`        }`);
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
    emit(`          ${CONT}`);
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
    emit(`        ${CONT}`);
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
    emit(`        ${CONT}`);
    emit(`      }`);
    emit(`    }`);
  }
  if (indent && plainContName && plainContDecl) {
    // A char no token can START here, right after a plain scalar inside a flow collection, is
    // mid-scalar content: consume it plus the plain body that follows (the merge pass joins it).
    emit(`    if (flowDepth > 0 && tokN > 0 && LX_FOLD[tkK[tokN - 1]] !== 0) {`);
    emit(`      const bodyM = source.slice(pos + 1).match(LX_PLAIN_FLOW);`);
    emit(`      const _e = pos + 1 + (bodyM !== null ? bodyM[0].length : 0);`);
    emit(`      tkPush(${kOf(plainContName)}, lexKwT(source, pos, _e), pos, _e);`);
    emit(`      pos = _e;`);
    emit(`      ${CONT}`);
    emit(`    }`);
  }
  emit(`    if (lexWindowMore) throw LEX_RETRY;`);
  emit(`    if (${recov}) {`);
  emit(`      docLex.push({ offset: pos + srcBase, end: pos + srcBase + 1, kind: 0, ch: source[pos] });`);
  emit(`      tkPush(${st.KIND_NAMED_FALLBACK}, 0, pos, pos + 1);`);
  emit(`      pos += 1;`);
  emit(`      ${CONT}`);
  emit(`    }`);
  emit(`    throw new Error("Unexpected character at offset " + pos + ": '" + source[pos] + "'");`);
  emit(`  }`);
  if (speculating) {
    emit(`  break;`);
    emit(`  } catch (e) { if (specTok < 0 || e === LEX_RETRY) throw e; specVerdict = 2; }`);
    emit(`  }`);
  }
  if (resync) emit(resyncRetractLine('  '));
  if (indent) {
    emit(`  while (indentStack.length > 1) { indentStack.pop(); tkPush(${kOf(indent.dedentToken)}, 0, pos, pos); }`);
    if (foldTokens.length) {
      // A plain scalar folded across a flow-internal newline arrives as ADJACENT plain tokens;
      // merge each run into one token over the raw span, typed by its LAST token (a comment
      // between them ends the scalar).
      emit(`  {`);
      emit(`    let w = 0, depth = 0;`);
      emit(`    for (let r = 0; r < tokN; r++) {`);
      emit(`      const k = tkK[r], t = tkT[r];`);
      emit(`      if (depth > 0 && w > 0 && (tkFl[r] & 2) === 0 && LX_FOLD[tkK[w - 1]] !== 0 && LX_FOLD[k] !== 0) {`);
      emit(`        tkEnd[w - 1] = tkEnd[r]; tkK[w - 1] = k;`);
      emit(`        tkT[w - 1] = lexKwT(source, tkOff[w - 1] - srcBase, tkEnd[r] - srcBase);`);
      emit(`      } else {`);
      emit(`        if (w !== r) {`);
      emit(`          tkK[w] = k; tkT[w] = t; tkOff[w] = tkOff[r]; tkEnd[w] = tkEnd[r];`);
      emit(`          tkFl[w] = tkFl[r]; tkDp[w] = tkDp[r]; tkPd[w] = tkPd[r];`);
      emit(`        }`);
      emit(`        w++;`);
      emit(`      }`);
      emit(`      if (k === K_PUNCT) { if (LX_FLOWOPEN[t] !== 0) depth++; else if (LX_FLOWCLOSE[t] !== 0) depth = depth > 0 ? depth - 1 : 0; }`);
      emit(`    }`);
      emit(`    tokN = w;`);
      emit(`  }`);
    }
  }
  emit(`  return hasMore ? -2 : -1;`);
  emit(`}`);
  if (windowed) {
    emit(`// Windowed-relex restart anchor: the last token B ending before the damage whose`);
    emit(`// recorded stack depths are zero and whose shape leaves no cross-token lexer flag`);
    emit(`// live. -1 = file head (always sound, degrades to a full re-lex)${stateful ? ' — the only anchor for this grammar: its mode state (markup / line structure) is not recorded per token' : ''}.`);
    emit(`function findRestart(cs«: number») {`);
    if (stateful) {
      emit(`  return -1;`);
    } else {
      // STRICTLY before the damage: a token ENDING exactly at cs can be EXTENDED by
      // the edit under maximal munch, so it must fall inside the window.
      emit(`  let lo = 0, hi = tokN;`);
      emit(`  while (lo < hi) { const mid = (lo + hi) >> 1; if (tend(mid) < cs) lo = mid + 1; else hi = mid; }`);
      emit(`  for (let b = lo - 1; b >= 0; b--) {`);
      emit(`    // template depth zero, and no live cross-token flag: not a control-head ')',`);
      emit(`    // not a postfix-ambiguous op, not a control KEYWORD. Paren depth may be`);
      emit(`    // anything — the live stack is reconstructed from the recorded depths.`);
      // (an expression-head keyword too: whether it is a member name reads the token before it,
    // which a window seeded with one previous token does not have)
    emit(`    if (tkDp[b] === 0${tracks ? ' && (tkFl[b] & 32) === 0' : ''} && LX_PFXV[tkT[b]] === 0 && LX_PARENKW[tkT[b]] === 0 && LX_EXPRKW[tkT[b]] === 0 && !(tkK[b] === 1 && tkT[b] === ${tRParen})) return b;`);
      emit(`  }`);
      emit(`  return -1;`);
    }
    emit(`}`);
    emit(`// Rebuild the live paren-head stack enclosing token b: scanning backward, the`);
    emit(`// first '(' recording exactly depth d is the live opener of level d. The '('`);
    emit(`// records its depth INCLUDING itself, and carries its control-head-ness as tkFl bit 8.`);
    emit(`function reconstructParens(b«: number») {`);
    emit(`  let need = b >= 0 ? tkPd[b] : 0;`);
    emit(`  const out«: boolean[]» = new Array(need);`);
    emit(`  for (let i = b; i >= 0 && need > 0; i--) {`);
    emit(`    if (tkK[i] === 1 && tkT[i] === ${tLParen} && tkPd[i] === need) { out[need - 1] = (tkFl[i] & 8) !== 0; need--; }`);
    emit(`  }`);
    emit(`  return out;`);
    emit(`}`);
    emit(`// Session cache for the live paren stack: the previous edit's anchor stack rolled`);
    emit(`// FORWARD over the tokens between the two anchors; a backward jump falls back to`);
    emit(`// the full scan.`);
    emit(`let parenCachePos = -1;`);
    emit(`let parenCacheStack«: boolean[]» = [];`);
    emit(`function reconstructParensCached(b«: number») {`);
    emit(`  let stack«: boolean[]»;`);
    emit(`  if (b < 0) stack = [];`);
    emit(`  else if (parenCachePos >= 0 && parenCachePos <= b) {`);
    emit(`    stack = parenCacheStack;`);
    emit(`    for (let i = parenCachePos + 1; i <= b; i++) {`);
    emit(`      if (tkK[i] === 1) {`);
    emit(`        if (tkT[i] === ${tLParen}) stack.push((tkFl[i] & 8) !== 0);`);
    emit(`        else if (tkT[i] === ${tRParen}) { if (stack.length > 0) stack.pop(); }`);
    emit(`      }`);
    emit(`    }`);
    emit(`  } else stack = reconstructParens(b);`);
    emit(`  parenCachePos = b; parenCacheStack = stack;`);
    emit(`  return stack.slice();`);
    emit(`}`);
  }
  return { code: finish(out.join('\n'), opts.ts), stateful };
}

// Indentation-mode sniffs over the source (all config is baked).
function emitIndentHelpers(emit: (s?: string) => void, indent: IndentConfig, kv: string, compact: string[], docMarkers: string[]) {
  const ccIn = (v: string, chars: string[]) => {
    const cs = [...new Set(chars.filter(c => c.length === 1).map(c => c.charCodeAt(0)))];
    return cs.length ? `(${cs.map(c => `${v} === ${c}`).join(' || ')})` : 'false';
  };
  // sepAfter(c): c is undefined (EOF) / space / tab / newline.
  emit(`function lxSepAfter(src«: string», i«: number») { if (i >= src.length) return true; const c = src.charCodeAt(i); return c === 32 || c === 9 || c === 10 || c === 13; }`);
  // keySepAt: the key/value separator followed by whitespace / EOL / a flow indicator.
  emit(`function lxKeySepAt(src«: string», i«: number») {`);
  emit(`  if (!(${startsWithExpr('src', 'i', kv)})) return false;`);
  emit(`  if (i + ${kv.length} >= src.length) return true;`);
  emit(`  const c = src.charCodeAt(i + ${kv.length});`);
  emit(`  return c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 91 || c === 93 || c === 123 || c === 125;`);
  emit(`}`);
  // Does the line from `start` carry a key separator (quoted regions skipped; an unterminated
  // quote or a ` #` comment ends the scan)?
  emit(`function lxLineHasKeySep(src«: string», start«: number») {`);
  emit(`  for (let i = start; i < src.length; i++) {`);
  emit(`    const ch = src.charCodeAt(i);`);
  emit(`    if (ch === 10 || ch === 13) break;`);
  emit(`    if (ch === 34) {`);
  emit(`      i++; while (i < src.length && src.charCodeAt(i) !== 34 && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) { if (src.charCodeAt(i) === 92) i++; i++; }`);
  emit(`      if (src.charCodeAt(i) !== 34) break; continue;`);
  emit(`    }`);
  emit(`    if (ch === 39) {`);
  emit(`      i++; while (i < src.length && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) { if (src.charCodeAt(i) === 39 && src.charCodeAt(i + 1) !== 39) break; if (src.charCodeAt(i) === 39) i++; i++; }`);
  emit(`      if (src.charCodeAt(i) !== 39) break; continue;`);
  emit(`    }`);
  emit(`    if ((ch === 32 || ch === 9) && src.charCodeAt(i + 1) === 35) break;`);
  emit(`    if (lxKeySepAt(src, i)) return true;`);
  emit(`  }`);
  emit(`  return false;`);
  emit(`}`);
  // Does the line content at `start` begin a BLOCK-STRUCTURAL node (whose leading whitespace is
  // its indentation)? `allowProperty`: a node property counts (not after a `:`).
  emit(`function lxStartsBlock(src«: string», start«: number», allowProperty«: boolean») {`);
  emit(`  const c0 = src.charCodeAt(start);`);
  emit(`  if (c0 === 91 || c0 === 123 || c0 === 42) return false;`);
  emit(`  if (start < src.length && ${ccIn('c0', compact)} && lxSepAfter(src, start + 1)) return true;`);
  emit(`  if (${startsWithExpr('src', 'start', kv)} && lxSepAfter(src, start + ${kv.length})) return true;`);
  emit(`  if (c0 === 38 || c0 === 33) return allowProperty;`);
  emit(`  for (let i = start; i < src.length; i++) {`);
  emit(`    const ch = src.charCodeAt(i);`);
  emit(`    if (ch === 10 || ch === 13) break;`);
  emit(`    if (ch === 34) { i++; while (i < src.length && src.charCodeAt(i) !== 34 && src.charCodeAt(i) !== 10) { if (src.charCodeAt(i) === 92) i++; i++; } continue; }`);
  emit(`    if (ch === 39) { i++; while (i < src.length && src.charCodeAt(i) !== 10) { if (src.charCodeAt(i) === 39 && src.charCodeAt(i + 1) !== 39) break; if (src.charCodeAt(i) === 39) i++; i++; } continue; }`);
  emit(`    if ((ch === 32 || ch === 9) && src.charCodeAt(i + 1) === 35) break;`);
  emit(`    if (lxKeySepAt(src, i)) return true;`);
  emit(`  }`);
  emit(`  return false;`);
  emit(`}`);
  // For a compact indicator: does its inline content begin a nested block collection (looking
  // through up to two property prefixes; a property alone on the line does not nest)?
  emit(`function lxCompactNests(src«: string», start«: number») {`);
  emit(`  let i = start;`);
  emit(`  for (let k = 0; k < 2; k++) {`);
  emit(`    const c = src.charCodeAt(i);`);
  emit(`    if (c === 38 || c === 33) {`);
  emit(`      i++; while (i < src.length && !lxSepAfter(src, i) && src.charCodeAt(i) !== 44) i++;`);
  emit(`      while (i < src.length && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;`);
  emit(`    } else break;`);
  emit(`  }`);
  emit(`  if (i >= src.length || src.charCodeAt(i) === 10 || src.charCodeAt(i) === 13) return false;`);
  emit(`  if (${ccIn('src.charCodeAt(i)', compact)} && lxSepAfter(src, i + 1)) return true;`);
  emit(`  return lxStartsBlock(src, i, false);`);
  emit(`}`);
  emit(`function lxDashAfter(src«: string», i«: number») {`);
  emit(`  let q = i; while (q < src.length && src.charCodeAt(q) === 32) q++;`);
  emit(`  return q > i && src.charCodeAt(q) === 45 && lxSepAfter(src, q + 1);`);
  emit(`}`);
  // A document marker at i, followed by whitespace / EOL.
  emit(`function lxMarkerAt(src«: string», i«: number») {`);
  for (const m of docMarkers) emit(`  if (${startsWithExpr('src', 'i', m)} && lxSepAfter(src, i + ${m.length})) return true;`);
  emit(`  return false;`);
  emit(`}`);
  void indent;
}

// The indent-mode block-context line start: blank / comment lines are skipped; the content
// line's leading-space column drives INDENT / DEDENT / NEWLINE plus the plain-scalar
// continuation fold.
function emitLineStart(emit: (s?: string) => void, indent: IndentConfig,
  lineComment: string | undefined, kOf: (n: string) => number, plainContName: string | null) {
  emit(`    if (flowDepth === 0 && lineStart) {`);
  emit(`      let p = pos, col = 0;`);
  emit(`      while (p < n && source.charCodeAt(p) === 32) { p++; col++; }`);
  emit(`      if (p >= n) { pos = p; lineStart = false; continue; }`);
  emit(`      const ch = source.charCodeAt(p);`);
  emit(`      if (ch === 10 || ch === 13) { pos = p + 1; if (ch === 13 && source.charCodeAt(pos) === 10) pos++; continue; }`);
  emit(`      if (ch === 9) {`);
  emit(`        let b = p; while (b < n && (source.charCodeAt(b) === 32 || source.charCodeAt(b) === 9)) b++;`);
  emit(`        const bc = source.charCodeAt(b);`);
  emit(`        if (b >= n || bc === 10 || bc === 13) {`);
  emit(`          pos = b; if (bc === 13 && source.charCodeAt(pos + 1) === 10) pos += 2; else if (b < n) pos++;`);
  emit(`          continue;`);
  emit(`        }`);
  if (indent) {
    // §6.1: a tab is illegal where the leading whitespace is a block-structural node's indentation.
    emit(`        let q = p; while (q < n && (source.charCodeAt(q) === 32 || source.charCodeAt(q) === 9)) q++;`);
    emit(`        const after = source.charCodeAt(q);`);
    emit(`        if (q < n && after !== 10 && after !== 13 && lxStartsBlock(source, q, true)) {`);
    emit(`          throw new Error('Tab character used in indentation at offset ' + p);`);
    emit(`        }`);
  }
  emit(`      }`);
  if (lineComment) {
    const except = indent?.commentExcept;
    emit(`      if (${startsWithExpr('source', 'p', lineComment)}${except ? ` && !(${startsWithExpr('source', `p + ${lineComment.length}`, except)})` : ''}) {`);
    emit(`        let e = p; while (e < n && source.charCodeAt(e) !== 10) e++;`);
    emit(`        pos = e; pendingComment = true; continue;`);
    emit(`      }`);
  }
  emit(`      pos = p;`);
  const kIndent = kOf(indent.indentToken);
  emit(`      currentLineCol = col;`);
  emit(`      const top = indentStack[indentStack.length - 1];`);
  emit(`      if (col > top) {`);
  if (plainContName) {
    // A deeper line right after a plain LEAF is its continuation (unless it carries a key
    // separator): INDENT + the whole line as one plain-continuation token.
    emit(`        if (tokN > 0 && LX_FOLD[tkK[tokN - 1]] !== 0 && !lxLineHasKeySep(source, pos)) {`);
    emit(`          indentStack.push(col);`);
    emit(`          tkPush(${kIndent}, 0, pos, pos);`);
    emit(`          let e = pos;`);
    const cmt = indent.comment;
    emit(`          while (e < n && source.charCodeAt(e) !== 10 && source.charCodeAt(e) !== 13${cmt !== undefined ? ` && !((source.charCodeAt(e) === 32 || source.charCodeAt(e) === 9) && ${startsWithExpr('source', 'e + 1', cmt)})` : ''}) e++;`);
    emit(`          let end = e; while (end > pos && (source.charCodeAt(end - 1) === 32 || source.charCodeAt(end - 1) === 9)) end--;`);
    emit(`          tkPush(${kOf(plainContName)}, lexKwT(source, pos, end), pos, end);`);
    emit(`          pos = e;`);
    emit(`          lineStart = false;`);
    emit(`          continue;`);
    emit(`        }`);
  }
  emit(`        indentStack.push(col);`);
  emit(`        tkPush(${kIndent}, 0, pos, pos);`);
  emit(`      } else {`);
  emit(`        while (indentStack.length > 1 && indentStack[indentStack.length - 1] > col) {`);
  emit(`          indentStack.pop();`);
  emit(`          tkPush(${kOf(indent.dedentToken)}, 0, pos, pos);`);
  emit(`        }`);
  emit(`        if (col < lastExplicitKeyCol) lastExplicitKeyCol = -1;`);
  emit(`        if (emittedContent && indentStack[indentStack.length - 1] === col) tkPush(${kOf(indent.newlineToken)}, 0, pos, pos);`);
  emit(`      }`);
  emit(`      lineStart = false;`);
  emit(`      atLineLead = true;`);
  emit(`      continue;`);
  emit(`    }`);
}

// Block scalar (YAML | / >): from the introducer line, all following lines more indented than
// the parent node (or at/above an explicit indentation indicator's pinned column) form ONE
// verbatim token; a col-0 document marker ends it.
function emitBlockScalar(emit: (s?: string) => void, indent: IndentConfig, kTok: number) {
  const bs = indent.blockScalar!;
  const intro = [...new Set(bs.introducers.filter(c => c.length === 1).map(c => c.charCodeAt(0)))];
  const markers = bs.documentMarkers ?? [];
  emit(`    if (flowDepth === 0 && (${intro.length ? intro.map(c => `cc === ${c}`).join(' || ') : 'false'}) && ((LX_BS_SIG.lastIndex = pos), LX_BS_SIG.test(source))) {`);
  emit(`      const startPos = pos;`);
  emit(`      let lineBegin = startPos; while (lineBegin > 0 && source.charCodeAt(lineBegin - 1) !== 10) lineBegin--;`);
  emit(`      const before = source.slice(lineBegin, startPos).replace(/^[ \\t]+/, '');`);
  emit(`      const atRoot = currentLineCol === 0 && (before === ''${markers.map(m => ` || before.startsWith(${J(m + ' ')})`).join('')});`);
  emit(`      const parentNode = indentStack[indentStack.length - 1];`);
  emit(`      const parent = atRoot ? -1 : parentNode;`);
  emit(`      LX_BS_IND.lastIndex = startPos + 1;`);
  emit(`      const indMatch = LX_BS_IND.exec(source);`);
  emit(`      const explicitIndicator = indMatch !== null;`);
  emit(`      const pinnedContentCol = indMatch !== null && !atRoot ? parentNode + Number(indMatch[1]) : -1;`);
  emit(`      let p = pos; while (p < n && source.charCodeAt(p) !== 10) p++; if (p < n) p++;`);
  emit(`      let maxLeadingBlankCol = -1, sawContent = false;`);
  emit(`      while (p < n) {`);
  emit(`        let q = p, c = 0;`);
  emit(`        while (q < n && source.charCodeAt(q) === 32) { q++; c++; }`);
  emit(`        if (q >= n) { p = q; break; }`);
  emit(`        const qc = source.charCodeAt(q);`);
  emit(`        if (qc === 10 || qc === 13) {`);
  emit(`          if (!sawContent && c > maxLeadingBlankCol) maxLeadingBlankCol = c;`);
  emit(`          p = q + 1; if (qc === 13 && source.charCodeAt(p) === 10) p++;`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`        if (qc === 9) {`);
  emit(`          let t = q; while (t < n && (source.charCodeAt(t) === 32 || source.charCodeAt(t) === 9)) t++;`);
  emit(`          const tc = source.charCodeAt(t);`);
  emit(`          if (t >= n || tc === 10 || tc === 13) {`);
  emit(`            if (c <= parent) throw new Error('Tab character used in indentation at offset ' + q);`);
  emit(`            if (!sawContent && c > maxLeadingBlankCol) maxLeadingBlankCol = c;`);
  emit(`            p = t + 1; if (tc === 13 && source.charCodeAt(p) === 10) p++;`);
  emit(`            continue;`);
  emit(`          }`);
  emit(`        }`);
  emit(`        if (c === 0 && lxMarkerAt(source, q)) break;`);
  emit(`        const isContent = pinnedContentCol >= 0 ? c >= pinnedContentCol : c > parent;`);
  emit(`        if (isContent) {`);
  emit(`          if (!sawContent && maxLeadingBlankCol > c && !explicitIndicator) {`);
  emit(`            throw new Error('Block scalar leading empty line is more indented than content at offset ' + q);`);
  emit(`          }`);
  emit(`          sawContent = true;`);
  emit(`          let e = q; while (e < n && source.charCodeAt(e) !== 10) e++; p = e < n ? e + 1 : e;`);
  emit(`        } else break;`);
  emit(`      }`);
  emit(`      const _e = p < n ? p : n;`);
  emit(`      tkPush(${kTok}, lexKwT(source, startPos, _e), startPos, _e);`);
  emit(`      pos = p;`);
  emit(`      lineStart = true;`);
  emit(`      continue;`);
  emit(`    }`);
}

// Raw content block: a line-TRAILING introducer glued to the line's content (or at the line
// lead) captures the following more-indented lines as ONE verbatim token.
function emitRawBlock(emit: (s?: string) => void, indent: IndentConfig, kTok: number) {
  const ch = indent.rawBlock!.introChar ?? ':';
  emit(`    if (flowDepth === 0 && ${ch.length === 1 ? `cc === ${ch.charCodeAt(0)}` : 'false'} && ((LX_RB_SIG.lastIndex = pos), LX_RB_SIG.test(source))) {`);
  emit(`      let lineBegin = pos; while (lineBegin > 0 && source.charCodeAt(lineBegin - 1) !== 10) lineBegin--;`);
  emit(`      const beforeText = source.slice(lineBegin, pos);`);
  emit(`      let glued = beforeText.length > 0 && /\\S/.test(beforeText);`);
  emit(`      if (glued) {`);
  emit(`        let depth = 0, quote = '';`);
  emit(`        const lead = (beforeText.match(/^[ \\t]*/)«!»)[0].length;`);
  emit(`        for (let i = lead; i < beforeText.length; i++) {`);
  emit(`          const c = beforeText[i];`);
  emit(`          if (quote) { if (c === quote) quote = ''; continue; }`);
  emit(`          if (c === '"' || c === "'" || c === '\`') quote = c;`);
  emit(`          else if (c === '(') depth++;`);
  emit(`          else if (c === ')') depth = Math.max(0, depth - 1);`);
  emit(`          else if ((c === ' ' || c === '\\t') && depth === 0) { glued = false; break; }`);
  emit(`        }`);
  emit(`      }`);
  emit(`      if (glued || /^[ \\t]*$/.test(beforeText)) {`);
  emit(`        const startPos = pos;`);
  emit(`        const parent = indentStack[indentStack.length - 1];`);
  emit(`        let p = pos; while (p < n && source.charCodeAt(p) !== 10) p++; if (p < n) p++;`);
  emit(`        while (p < n) {`);
  emit(`          let q = p, c = 0;`);
  emit(`          while (q < n && source.charCodeAt(q) === 32) { q++; c++; }`);
  emit(`          if (q >= n) { p = q; break; }`);
  emit(`          const qc = source.charCodeAt(q);`);
  emit(`          if (qc === 10 || qc === 13) { p = q + 1; if (qc === 13 && source.charCodeAt(p) === 10) p++; continue; }`);
  emit(`          if (c > parent) { let e = q; while (e < n && source.charCodeAt(e) !== 10) e++; p = e < n ? e + 1 : e; }`);
  emit(`          else break;`);
  emit(`        }`);
  emit(`        tkPush(${kTok}, lexKwT(source, startPos, p), startPos, p);`);
  emit(`        pos = p;`);
  emit(`        lineStart = true;`);
  emit(`        continue;`);
  emit(`      }`);
  emit(`    }`);
}

// A baked `source.startsWith(lit, pos)` as charCode compares; `cc0Var` names a variable
// already holding charCodeAt(pos) (so char 0 reuses it).
function startsWithExpr(src: string, posVar: string, lit: string, cc0Var?: string): string {
  if (lit.length === 0) return 'true';
  const parts: string[] = [];
  for (let i = 0; i < lit.length; i++) {
    const lhs = i === 0 && cc0Var ? cc0Var : `${src}.charCodeAt(${posVar}${i === 0 ? '' : ` + ${i}`})`;
    parts.push(`${lhs} === ${lit.charCodeAt(i)}`);
  }
  return parts.join(' && ');
}

type TextTokenPlan = { re: string; k: number; skip: boolean; readEnd: string | null; overEnd: string | null; pattern: TokenPattern; first: CSet; after: CSet | null };
type ElementCtx = {
  kOf: (name: string) => number; puT: (text: string) => number; tOf?: (text: string) => number;
  startsWithExpr: typeof startsWithExpr; J?: (v: unknown) => string; punctIs?: (i: string, lits: string[]) => string;
  headOverEnd?: string | null; textTokens: TextTokenPlan[];
  dirs?: Directives | null; dirCtx?: { idCont: CSet; skips: { re: string; first: CSet; readEnd: string | null }[]; looks: boolean } | null;
};
// The first units of a region's directive openers and code block openers.
const dirFirst = (d: Directives): CSet => union([], [...d.openers.map(o => o.lit), ...d.blocks].map((l): [number, number] => [l.charCodeAt(0), l.charCodeAt(0)]));
// A failed attempt of a text token at `at`: its read, past the end + 1 of the token it decides,
// is recorded (the relex anchor rule; the read bound is the scan matcher's own).
const ttFailRecord = (t: TextTokenPlan, at: string) => (t.readEnd ? ` { const r = ${t.readEnd}(source, ${at}); if (r > lxLookEnd) lxLookEnd = r; }` : '');

// Element-region helpers inside lexCore: whether a tagOpen at an operand position opens an
// element (the type-parameter vetoes), the rewind of an undecided signature, and a tag's end.
function emitElementHelpers(emit: (s?: string) => void, el: ElementRegion, enterAlways: boolean, c: ElementCtx) {
  const L = el.tagOpen.length;
  const tp = el.typeParameters;
  if (!enterAlways) {
    emit(`  function lxOpensElement(p«: number») {`);
    // a head that begins type parameters decides the tagOpen by what its match read (a failed one
    // opens an element, whose frame holds every token its attempt read)
    if (tp?.head) emit(`    LX_TP_HEAD.lastIndex = p + ${L}; if (LX_TP_HEAD.test(source)) { ${c.headOverEnd ? `const e = LX_TP_HEAD.lastIndex, c = e < source.length ? source.charCodeAt(e) : -1, r = c >= 0 && ${unitIn('c', overTrigger(tp!.head!))} ? ${c.headOverEnd}(source, e) : e + 1; if (r > lxLookEnd) lxLookEnd = r; ` : ''}return false; }`);
    if (tp?.signature) {
      emit(`    LX_TP_SIG.lastIndex = p + ${L};`);
      emit(`    if (LX_TP_SIG.test(source)) {`);
      emit(`      specTok = tokN; specVerdict = 0; specClosedAt = -1; specParenBase = parenHeadStack.length;`);
      emit(`      specDocLex = docLex.length; specPops = lexEmptyPops.length;`);
      emit(`      specStack = templateStack.slice(); specParens = parenHeadStack.slice();`);
      emit(`      return false;`);
      emit(`    }`);
    }
    emit(`    return true;`);
    emit(`  }`);
  }
  if (tp?.signature) {
    // The head `tagOpen Name tagClose` was an open tag: keep its three tokens, drop what the
    // group was lexed into, restore the stacks and lex the children.
    emit(`  function lxSpecRewind() {`);
    emit(`    const s = specTok;`);
    emit(`    specTok = -1; specVerdict = 0; specClosedAt = -1;`);
    emit(`    tokN = s + 3;`);
    emit(`    templateStack.length = 0; for (let i = 0; i < specStack.length; i++) templateStack.push(specStack[i]);`);
    emit(`    parenHeadStack.length = 0; for (let i = 0; i < specParens.length; i++) parenHeadStack.push(specParens[i]);`);
    emit(`    docLex.length = specDocLex; lexEmptyPops.length = specPops;`);
    emit(`    templateStack.push(18);`);
    emit(`    const d = templateStack.length > 255 ? 255 : templateStack.length;`);
    emit(`    tkDp[s] = d; tkDp[s + 1] = d; tkDp[s + 2] = d;`);
    emit(`    pos = tkEnd[s + 2] - srcBase«!»;`);
    emit(`    pendingNl = false; extraFl = 0; tagAngle = 0;`);
    if (el.rawText?.length) emit(`    lxTagAt[templateStack.length - 1] = s; lxRawText(templateStack.length - 1);`);
    emit(`  }`);
  }
  if (c.textTokens.length || c.dirs) {
    // Inside a text run (q past its first unit): whether a text token or a directive opener
    // starts at q, so the run stops before it. Its match is taken at the next run's start, which
    // records a text token's over-read.
    emit(`  function lxTextStopAt(q«: number») {`);
    emit(`    const c = source.charCodeAt(q);`);
    for (const t of c.textTokens) {
      const cond = [unitIn('c', t.first), ...(t.after ? [`((b) => ${unitIn('b', t.after)})(source.charCodeAt(q - 1))`] : [])].join(' && ');
      emit(`    if (${cond}) { ${t.re}.lastIndex = q; if (${t.re}.test(source)) return true;${ttFailRecord(t, 'q')} }`);
    }
    if (c.dirs) emit(`    if (${unitIn('c', dirFirst(c.dirs))} && lxDirAt(q, LX_DIR_OPEN, false) >= 0) return true;`);
    emit(`    return false;`);
    emit(`  }`);
  }
  if (c.dirs) {
    const x = c.dirCtx!;
    // code trivia after a directive literal: whitespace and the grammar's skip tokens (a failed
    // skip attempt's read is recorded as the scan matcher's)
    emit(`  function lxTrivia(p«: number») {`);
    emit(`    for (;;) {`);
    emit(`      LX_WS.lastIndex = p; const w = LX_WS.exec(source); if (w !== null) p += w[0].length;`);
    emit(`      if (p >= n) return p;`);
    emit(`      const c = source.charCodeAt(p);`);
    emit(`      let moved = false;`);
    for (const s of x.skips) emit(`      if (!moved && ${unitIn('c', s.first)}) { ${s.re}.lastIndex = p; const m = ${s.re}.exec(source); if (m !== null && m[0].length > 0) { p += m[0].length; moved = true; }${s.readEnd ? ` else { const r = ${s.readEnd}(source, p); if (r > lxLookEnd) lxLookEnd = r; }` : ''} }`);
    emit(`      if (!moved) return p;`);
    emit(`    }`);
    emit(`  }`);
    // A directive literal of \`tab\` at q (after blanks, with \`lead\`), not running on into an
    // identifier, followed by one of its required literal sequences (trivia between): its index,
    // or -1. What it read is recorded (a comment in the trivia can reach the end of the file).
    emit(`  function lxDirAt(q«: number», tab«: [string, number, [string, number][][]][]», lead«: boolean») {`);
    emit(`    let p0 = q;`);
    emit(`    if (lead) { LX_WS.lastIndex = q; const w = LX_WS.exec(source); if (w !== null) p0 += w[0].length; }`);
    emit(`    let far = p0 + 1, hit = -1;`);
    emit(`    for (let i = 0; i < tab.length && hit < 0; i++) {`);
    emit(`      const d = tab[i];`);
    emit(`      if (!source.startsWith(d[0], p0)) continue;`);
    emit(`      const e = p0 + d[0].length;`);
    emit(`      if (e + 1 > far) far = e + 1;`);
    emit(`      if (d[1] === 1 && e < n && lxIdCont(source.charCodeAt(e))) continue;`);
    emit(`      for (const nx of d[2]) {`);
    emit(`        let p = e, ok = true;`);
    emit(`        for (const [l, w] of nx) {`);
    emit(`          p = lxTrivia(p);`);
    emit(`          if (p + l.length + 1 > far) far = p + l.length + 1;`);
    emit(`          if (!source.startsWith(l, p) || (w !== 0 && p + l.length < n && lxIdCont(source.charCodeAt(p + l.length)))) { ok = false; break; }`);
    emit(`          p += l.length;`);
    emit(`        }`);
    emit(`        if (ok) { hit = i; break; }`);
    emit(`      }`);
    emit(`    }`);
    if (x.looks) emit(`    if (far > lxLookEnd) lxLookEnd = far;`);
    emit(`    return hit;`);
    emit(`  }`);
    // A body's closer was just pushed: a continuation after it returns the frame to a head (the
    // ordinary scan lexes it and what follows as code); otherwise the directive ends.
    emit(`  function lxDirAfterBody(top«: number») {`);
    emit(`    if (lxDirAt(pos, LX_DIR_CONT, true) >= 0) templateStack[top] = 14 | ((parenHeadStack.length + 1) << 4);`);
    emit(`    else templateStack.pop();`);
    emit(`  }`);
  }
  // A tag ended (its tagClose or self-close token was just pushed): an open tag adds an open
  // element, a close tag removes one; at none the frame pops and that token is a value.
  emit(`  function lxTagEnd(selfClosed«: boolean») {`);
  emit(`    const top = templateStack.length - 1, fr = templateStack[top];`);
  emit(`    let count = fr >> 4;`);
  if (el.rawText?.length) emit(`    const opened = !selfClosed && ((fr >> 2) & 3) === 1;`);
  emit(`    if (!selfClosed) count += ((fr >> 2) & 3) === 1 ? 1 : -1;`);
  emit(`    if (count <= 0) { templateStack.pop(); tkFl[tokN - 1] |= 16; }`);
  emit(`    else templateStack[top] = (count << 4) | 2;`);
  emit(`    tagAngle = 0;`);
  if (el.rawText?.length) emit(`    if (opened) lxRawText(top);`);
  emit(`  }`);
  if (el.rawText?.length) {
    // An open tag just ended: when its name (the token after its tagOpen, if that is not the
    // tagClose itself) is a raw-text name, the body up to tagOpen + closeMarker + name is ONE raw
    // token, pushed inside a raw frame (kind 3) and popped after it; the close tag is lexed next,
    // in the children, as any close tag.
    const close = el.tagOpen + el.closeMarker;
    emit(`  function lxRawText(top«: number») {`);
    emit(`    const i = lxTagAt[top] + 1;`);
    emit(`    if (i >= tokN - 1) return;`);
    emit(`    const name = source.slice(tkOff[i] - lexSrcBase, tkEnd[i] - lexSrcBase);`);
    emit(`    let k = LX_RAW_EXACT.get(name), end = -1;`);
    if (el.rawText.some(r => r.unlessBodyStarts !== undefined)) {
      // the body-start condition under which this name's body is ordinary children
      emit(`    const ux = k !== undefined ? LX_RAW_UNLESS_EXACT.get(name) : LX_RAW_UNLESS_FOLD.get(name.toLowerCase());`);
      emit(`    if (ux !== undefined) { ux.lastIndex = pos; if (ux.test(source)) return; }`);
    }
    emit(`    if (k !== undefined) end = source.indexOf(${J(close)} + name, pos);`);
    emit(`    else {`);
    emit(`      k = LX_RAW_FOLD.get(name.toLowerCase());`);
    emit(`      if (k === undefined) return;`);
    emit(`      const re = LX_RAW_FOLD_END.get(name.toLowerCase())«!»;`);
    emit(`      re.lastIndex = pos;`);
    emit(`      const m = re.exec(source);`);
    emit(`      end = m === null ? -1 : m.index;`);
    emit(`    }`);
    emit(`    if (end < 0) end = n;`);
    emit(`    if (end > pos) { templateStack.push(3); tkPush(k, 0, pos, end); templateStack.pop(); pos = end; }`);
    emit(`  }`);
  }
}

// The element text frame at the top of the stack: children text, or the tag delimiters.
// Anything else in a tag falls through to the ordinary scan (no regex there: prevIsValue).
function emitElementFrame(emit: (s?: string) => void, el: ElementRegion, c: ElementCtx) {
  const sw = (lit: string, at = 'pos') => c.startsWithExpr('source', at, lit, at === 'pos' ? 'cc' : undefined);
  const L = el.tagOpen.length, LC = el.tagOpen.length + el.closeMarker.length;
  const LS = el.closeMarker.length + el.tagClose.length, LH = el.hole.open.length;
  emit(`    if (templateStack.length > 0 && (templateStack[templateStack.length - 1] & 3) === 2) {`);
  emit(`      const top = templateStack.length - 1, fr = templateStack[top], sub = (fr >> 2) & 3;`);
  const ts = el.tagStart !== undefined ? ` && lxTagStart(source, pos + ${L})` : '';
  const D = c.dirs, LHC = el.hole.close.length;
  // a directive body (sub-state 3, count 0) is children; in it a tag opens a frame of its own
  emit(D ? `      if (sub === 0 || (sub === 3 && (fr >> 4) === 0)) {` : `      if (sub === 0) {`);
  emit(`        if (${sw(el.tagOpen)}${ts}) {`);
  if (D) {
    // a close tag in a body closes no element of it: a frame of its own that pops at its tagClose
    emit(`          if (sub === 3) {`);
    emit(`            const close = ${c.startsWithExpr('source', `pos + ${L}`, el.closeMarker)};`);
    emit(`            templateStack.push(close ? 10 : 6);`);
    if (el.rawText?.length) emit(`            if (!close) lxTagAt[templateStack.length - 1] = tokN;`);
    emit(`            if (close) { tkPush(${c.kOf(el.closeTag)}, 0, pos, pos + ${LC}); pos += ${LC}; }`);
    emit(`            else { tkPush(K_PUNCT, ${c.puT(el.tagOpen)}, pos, pos + ${L}); pos += ${L}; }`);
    emit(`            tagAngle = 0;`);
    emit(`            continue;`);
    emit(`          }`);
  }
  emit(`          if (${c.startsWithExpr('source', `pos + ${L}`, el.closeMarker)}) {`);
  emit(`            tkPush(${c.kOf(el.closeTag)}, 0, pos, pos + ${LC});`);
  emit(`            pos += ${LC}; templateStack[top] = fr | 8; tagAngle = 0;`);
  emit(`            continue;`);
  emit(`          }`);
  if (el.rawText?.length) emit(`          lxTagAt[top] = tokN;`);
  emit(`          tkPush(K_PUNCT, ${c.puT(el.tagOpen)}, pos, pos + ${L});`);
  emit(`          pos += ${L}; templateStack[top] = fr | 4; tagAngle = 0;`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`        if (${sw(el.hole.open)}) {`);
  emit(`          templateStack.push(1);`);
  emit(`          tkPush(K_PUNCT, ${c.tOf!(el.hole.open)}, pos, pos + ${LH});`);
  emit(`          pos += ${LH};`);
  emit(`          continue;`);
  emit(`        }`);
  if (D) {
    // a body's closer; then a continuation, or the directive's end
    emit(`        if (sub === 3 && ${sw(el.hole.close)}) {`);
    emit(`          tkPush(K_PUNCT, ${c.tOf!(el.hole.close)}, pos, pos + ${LHC});`);
    emit(`          pos += ${LHC};`);
    emit(`          lxDirAfterBody(top);`);
    emit(`          continue;`);
    emit(`        }`);
    // a directive opener: its frame (a head, lexed as code) is pushed before its token, which the
    // ordinary scan then lexes in it (a word literal is a keyword of a scanned token, as in code);
    // a code block opener pushes an element hole
    emit(`        if (${unitIn('cc', dirFirst(D))}) {`);
    emit(`          const d = lxDirAt(pos, LX_DIR_OPEN, false);`);
    emit(`          if (d >= 0) {`);
    emit(`            templateStack.push(LX_DIR_OPEN[d][1] === 2 ? 1 : 14 | ((parenHeadStack.length + 1) << 4));`);
    emit(`            continue;`);
    emit(`          }`);
    emit(`        }`);
  }
  for (const t of c.textTokens) {
    // a text token at the run's start (after a tag, a hole, another text token or a text run
    // that stopped before it)
    emit(`        if (${unitIn('cc', t.first)}) {`);
    emit(`          ${t.re}.lastIndex = pos;`);
    emit(`          const xm = ${t.re}.exec(source);`);
    emit(`          if (xm !== null && xm[0].length > 0) {`);
    if (t.overEnd) emit(`            { const e = pos + xm[0].length; if (e < n) { const c = source.charCodeAt(e); if (${unitIn('c', overTrigger(t.pattern))}) { const r = ${t.overEnd}(source, e); if (r > lxLookEnd) lxLookEnd = r; } } }`);
    if (t.skip) {
      emit(`            if (/[\\n\\r\\u2028\\u2029]/.test(xm[0])) pendingNl = true;`);
      emit(`            pos += xm[0].length;`);
    } else {
      emit(`            tkPush(${t.k}, 0, pos, pos + xm[0].length);`);
      emit(`            pos += xm[0].length;`);
    }
    emit(`            continue;`);
    emit(`          }${ttFailRecord(t, 'pos')}`);
    emit(`        }`);
  }
  if (el.text !== undefined && el.tagStart === undefined && !c.textTokens.length && !D) {
    emit(`        LX_EL_TEXT.lastIndex = pos;`);
    emit(`        const tm = LX_EL_TEXT.exec(source);`);
    emit(`        if (tm !== null && tm[0].length > 0) {`);
    emit(`          const _e = pos + tm[0].length;`);
    emit(`          tkPush(${c.kOf(el.text)}, 0, pos, _e);`);
    emit(`          pos = _e;`);
    emit(`          continue;`);
    emit(`        }`);
  } else if (el.text !== undefined) {
    // the text run: runs of the text token's class, joined by every tagOpen that opens no tag
    // (\`tagStart\`), up to the first text token after its first unit
    emit(`        let _e = pos;`);
    emit(`        for (;;) {`);
    emit(`          LX_EL_TEXT.lastIndex = _e;`);
    emit(`          const tm = LX_EL_TEXT.exec(source);`);
    if (c.textTokens.length || D) {
      emit(`          const _r = tm !== null ? _e + tm[0].length : _e;`);
      emit(`          let q = _e > pos ? _e : pos + 1;`);
      emit(`          while (q < _r && !lxTextStopAt(q)) q++;`);
      emit(`          if (q < _r) { _e = q; break; }`);
      emit(`          _e = _r;`);
    } else emit(`          if (tm !== null) _e += tm[0].length;`);
    if (el.tagStart !== undefined) emit(`          if (${sw(el.tagOpen, '_e')} && !lxTagStart(source, _e + ${L})${c.textTokens.length || D ? ` && !(_e > pos && lxTextStopAt(_e))` : ''}) { _e += ${L}; continue; }`);
    emit(`          break;`);
    emit(`        }`);
    emit(`        if (_e > pos) {`);
    emit(`          tkPush(${c.kOf(el.text)}, 0, pos, _e);`);
    emit(`          pos = _e;`);
    emit(`          continue;`);
    emit(`        }`);
  }
  // without a text token the children are code: anything else falls through to the ordinary scan
  if (D) {
    // a directive head (sub-state 3, count = its paren depth + 1): code, by the ordinary scan; a
    // hole opener at that depth opens the body, a deeper one an element hole
    emit(`      } else if (sub === 3) {`);
    emit(`        if (${sw(el.hole.open)}) {`);
    emit(`          if (parenHeadStack.length === (fr >> 4) - 1) templateStack[top] = 14; else templateStack.push(1);`);
    emit(`          tkPush(K_PUNCT, ${c.tOf!(el.hole.open)}, pos, pos + ${LH});`);
    emit(`          pos += ${LH};`);
    emit(`          continue;`);
    emit(`        }`);
  }
  emit(`      } else {`);
  // a tag's own tokens (outside type arguments): tried before the ordinary scan
  (el.tagTokens ?? []).forEach((name, i) => {
    emit(`        if (tagAngle === 0) { LX_EL_TAG_${i}.lastIndex = pos; const gm = LX_EL_TAG_${i}.exec(source);`);
    emit(`          if (gm !== null && gm[0].length > 0) { const _e = pos + gm[0].length; tkPush(${c.kOf(name)}, 0, pos, _e); pos = _e; continue; } }`);
  });
  emit(`        if (sub === 1 && tagAngle === 0 && ${c.startsWithExpr('source', 'pos', el.closeMarker + el.tagClose, 'cc')}) {`);
  emit(`          tkPush(${c.kOf(el.selfClose)}, 0, pos, pos + ${LS});`);
  emit(`          pos += ${LS};`);
  emit(`          lxTagEnd(true);`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`        if (${sw(el.tagClose)}) {`);
  emit(`          tkPush(K_PUNCT, ${c.puT(el.tagClose)}, pos, pos + ${el.tagClose.length});`);
  emit(`          pos += ${el.tagClose.length};`);
  emit(`          if (tagAngle > 0) tagAngle--; else lxTagEnd(false);`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`        if (${sw(el.tagOpen)}${ts}) {`);
  // after the attribute assign an element is a value (`a=<b/>`); elsewhere type arguments
  emit(`          const nested = tokN > 0 && ${c.punctIs!('tokN - 1', ['='])};`);
  emit(el.rawText?.length ? `          if (nested) { templateStack.push(6); lxTagAt[templateStack.length - 1] = tokN; } else tagAngle++;` : `          if (nested) templateStack.push(6); else tagAngle++;`);
  emit(`          tkPush(K_PUNCT, ${c.puT(el.tagOpen)}, pos, pos + ${L});`);
  emit(`          pos += ${L};`);
  emit(`          if (nested) tagAngle = 0;`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`        if (tagAngle === 0 && ${sw(el.hole.open)}) {`);
  emit(`          templateStack.push(1);`);
  emit(`          tkPush(K_PUNCT, ${c.tOf!(el.hole.open)}, pos, pos + ${LH});`);
  emit(`          pos += ${LH};`);
  emit(`          continue;`);
  emit(`        }`);
  emit(`      }`);
  emit(`    }`);
}
