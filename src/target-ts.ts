// The TypeScript Target for emit-portable. Renders the language-agnostic ParserIR into a
// self-contained TS parser: a char-class/string/comment lexer, a backtracking recursive-
// descent core, a Pratt expression engine (prefix + binary precedence + mixfix call/member/
// index LEDs), and a CST→JSON printer over stdin. It is the reference rendering — its CST
// is checked byte-for-byte against the interpreter (createParser), so a divergence in the
// portable logic surfaces here before Go/Rust are compiled.
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, TplCfg, NewlineCfg, FirstSig } from './emit-portable.ts';
import { portableIR } from './emit-portable.ts';
import type { Target } from './emit.ts';
import type { CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} === ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string) => f
  ? `(${f.lits.map((l) => `${t}.text === ${J(l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kind === ${J(k)}`).join(' || ') || 'false'})`
  : 'false';

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

function scanTok(t: LexTok, defs: string[], stateful: boolean, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token is scanned by the state machine
  // `emit(...)` threads the lexer state in stateful mode; a plain push otherwise. A skipped
  // token (comment) still records a newline it spans, so `sameLine` sees it.
  const push = (endExpr: string) => (t.skip ? `if (/[\\n\\r\\u2028\\u2029]/.test(src.slice(pos, ${endExpr}))) pendingNl = true; ` : `${stateful ? 'emit' : 'push'}(${J(name)}, src.slice(pos, ${endExpr}), pos, ${endExpr}); `);
  const gate = rxTok !== undefined && name === rxTok ? '!prevIsValue() && ' : '';
  if (t.kind === 'run') return `    if (${gate}${rangeCond('c', t.first)}) {
      let e = pos + 1;
      while (e < n) { const cc = src.charCodeAt(e); if (!${rangeCond('cc', t.cont)}) break; e++; }
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'string') return `    if (${gate}c === ${t.delim.charCodeAt(0)}) {
      let e = pos + 1;
      while (e < n) { const ch = src.charCodeAt(e); if (ch === 92) { e += 2; continue; } if (ch === ${t.delim.charCodeAt(0)}) { e++; break; } e++; }
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'line') return `    if (${gate}src.startsWith(${J(t.prefix)}, pos)) {
      let e = pos + ${t.prefix.length};
      while (e < n && src.charCodeAt(e) !== 10) e++;
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'block') return `    if (${gate}src.startsWith(${J(t.open)}, pos)) {
      let e = pos + ${t.open.length};
      while (e < n && !src.startsWith(${J(t.close)}, e)) e++;
      if (e < n) e += ${t.close.length};
      ${push('e')}pos = e; continue;
    }`;
  const m = compilePat(t.pattern, defs);
  return `    if (${gate}true) { const e = ${m}(pos); if (e > pos) { ${push('e')}pos = e; continue; } }`;
}

function newlineParts(nl: NewlineCfg, pushFn: string): { state: string; boundary: string; ws: string; hooks: string } {
  const commentSkip = nl.comment
    ? `      if (src.startsWith(${J(nl.comment)}, p)) { let e = p; while (e < n && src.charCodeAt(e) !== 10) e++; pos = e; continue; }\n`
    : '';
  return {
    state: `  let lineStart = true, emittedContent = false, flowDepth = 0;
  const _flowOpen = new Set([${nl.flowOpen.map(J).join(', ')}]);
  const _flowClose = new Set([${nl.flowClose.map(J).join(', ')}]);
  const _nlTok = ${J(nl.token)};
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
      if (emittedContent) ${pushFn}(_nlTok, '', pos, pos);
      lineStart = false;
      continue;
    }
`,
    ws: `    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) { pos++; continue; }
    if (c === 10 || c === 13) {   // LF/CR only — LS/PS fall through to the unexpected-character throw, matching the interpreter
      pos++; if (c === 13 && pos < n && src.charCodeAt(pos) === 10) pos++;
      if (flowDepth === 0) lineStart = true;
      else pendingNl = true;
      continue;
    }
`,
    hooks: `    if (kind !== _nlTok) emittedContent = true;
    if (kind === '' && _flowOpen.has(text)) flowDepth++;
    else if (kind === '' && _flowClose.has(text)) flowDepth = Math.max(0, flowDepth - 1);
`,
  };
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const stateful = !!(rx || tpl || nl);
  const toks = ir.tokens.map((t) => scanTok(t, defs, stateful, rx?.regexToken, tpl?.token)).join('\n');
  const pushFn = stateful ? 'emit' : 'push';
  const puncts = ir.puncts.map((p) =>
    `    if (src.startsWith(${J(p)}, pos)) { ${pushFn}('', ${J(p)}, pos, pos + ${p.length}); pos += ${p.length}; continue; }`).join('\n');
  const set = (a: string[]) => `new Set([${a.map(J).join(', ')}])`;
  // Per-feature pieces of the shared `emit`, so a grammar can have regex, templates, or both.
  const rxState = rx ? `  let prevText = '', prevKind = '', bpText = '', hasPrev = false, hasPrev2 = false;
  const parenHead: boolean[] = [];
  let lastClose = false, lastBang = false;
  const _divT = ${set(rx.divisionTexts)}, _divK = ${set(rx.divisionTypes)}, _rxT = ${set(rx.regexTexts)};
  const _phK = ${set(rx.parenHeadKw)}, _mem = ${set(rx.memberAccess)}, _pav = ${set(rx.postfixAfterValue)};
  const IDENT = ${J(rx.identToken)};
  function prevIsValue(): boolean {
    if (!hasPrev) return false;
    if (_pav.has(prevText)) return lastBang;
    const isExprKw = prevKind === IDENT && _rxT.has(prevText);
    const isParenHead = prevText === ')' && lastClose;
    return !isExprKw && !isParenHead && (_divK.has(prevKind) || _divT.has(prevText));
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
    return { interp: false, end: p };
  }
` : '';
  const emitHooks = [
    rx ? `    if (text === '(') { const isMember = hasPrev2 && _mem.has(bpText); parenHead.push(!isMember && prevKind === IDENT && _phK.has(prevText)); }
    else if (text === ')') { lastClose = parenHead.pop() ?? false; }
    if (_pav.has(text)) lastBang = prevIsValue();` : '',
    tpl ? `    if (templateStack.length > 0) { if (text === ${J(tpl.braceOpen)}) templateStack[templateStack.length - 1]++; else if (text === ${J(tpl.interpClose)}) templateStack[templateStack.length - 1]--; }` : '',
    nl ? newlineParts(nl, 'emit').hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n    bpText = prevText; hasPrev2 = hasPrev; prevKind = kind; prevText = text; hasPrev = true;` : '';
  const emitFn = stateful ? `  function emit(kind: string, text: string, off: number, end: number): void {
${emitHooks}
    toks.push({ kind, text, off, end, nl: pendingNl }); pendingNl = false;${emitTail}
  }
` : '';
  // Template dispatch runs at the top of the loop, before token/punct scanning.
  const tplDispatch = tpl ? `    if (templateStack.length > 0 && src.startsWith(${J(tpl.interpClose)}, pos) && templateStack[templateStack.length - 1] === 0) {
      templateStack.pop();
      const sp = scanTplSpan(pos + ${tpl.interpClose.length});
      if (sp.interp) { emit('$templateMiddle', src.slice(pos, sp.end), pos, sp.end); templateStack.push(0); }
      else emit('$templateTail', src.slice(pos, sp.end), pos, sp.end);
      pos = sp.end; continue;
    }
    if (src.startsWith(${J(tpl.open)}, pos)) {
      const sp = scanTplSpan(pos + ${tpl.open.length});
      if (sp.interp) { emit('$templateHead', src.slice(pos, sp.end), pos, sp.end); templateStack.push(0); }
      else emit(${J(tpl.token)}, src.slice(pos, sp.end), pos, sp.end);
      pos = sp.end; continue;
    }
` : '';
  const nlState = nl ? newlineParts(nl, stateful ? 'emit' : 'push').state : '';
  const nlBoundary = nl ? newlineParts(nl, stateful ? 'emit' : 'push').boundary : '';
  const nlWs = nl ? newlineParts(nl, stateful ? 'emit' : 'push').ws : `    if (c === 10 || c === 13 || c === 8232 || c === 8233) { pendingNl = true; pos++; continue; }
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 65279) { pos++; continue; }
`;
  const pushHooks = nl && !stateful ? newlineParts(nl, 'push').hooks : '';
  const pushFnDef = stateful ? '' : nl
    ? `  const push = (kind: string, text: string, off: number, end: number) => {
${pushHooks}    toks.push({ kind, text, off, end, nl: pendingNl }); pendingNl = false;
  };
`
    : '  const push = (kind: string, text: string, off: number, end: number) => { toks.push({ kind, text, off, end, nl: pendingNl }); pendingNl = false; };\n';
  return `${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let pos = 0;
  let pendingNl = false;
${defs.length ? '  _s = src;\n' : ''}${rxState}${tplState}${nlState}${stateful ? emitFn : pushFnDef}  while (pos < n) {
${nlBoundary}    const c = src.charCodeAt(pos);
    // JS line terminators LF/CR/LS/PS set newline-before, matching the interpreter (gen-lexer.ts).
${nlWs}${tplDispatch}${toks}
${puncts}
    throw new Error('lex error at ' + pos + ': ' + JSON.stringify(src[pos]));
  }
  return toks;
}`;
}

// A Step as a boolean expression (appends to the in-scope `kids`).
function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `matchLit(${J(s.value)}, ${J(s.ttype)}, kids)`;
    case 'tok': return `matchTok(${J(s.name)}, kids)`;
    case 'rule': return `callRule(parse${s.name}, kids)`;
    case 'ruleBp': return `callRule(() => ${s.name}_bp(${s.bp}), kids)`;
  case 'star': return `star(() => ${stepCond(s.step)}, kids)`;
  case 'opt': return `opt(() => ${s.steps.map(stepCond).join(' && ')}, kids)`;
  case 'sep': return `sepBy(() => ${stepCond(s.elem)}, ${J(s.delim)}, kids)`;
    case 'altlit': return `altLit([${s.opts.map((o) => `[${J(o.value)}, ${J(o.ttype)}]`).join(', ')}], kids)`;
    case 'alt': return s.predictive ? `(() => { ${predAltBody(s.branches, s.firsts)} })()` : `(() => { ${s.branches.map((br) => `{ const sp = pos; const bk = kids.length; if (${br.length ? br.map(stepCond).join(' && ') : 'true'}) return true; pos = sp; kids.length = bk; }`).join(' ')} return false; })()`;
    case 'not': return `(() => { const sp = pos; const bk = kids.length; const m = ${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'}; pos = sp; kids.length = bk; return !m; })()`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'})`;
    case 'sameLine': return `(() => { const t = peek(); return t !== null && !t.nl; })()`;
    case 'suppress': return `(() => { _suppressNext = new Set([${s.connectors.map(J).join(', ')}]); const _r = (${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'}); _suppressNext = null; return _r; })()`;
  }
}

function predAltBody(branches: Step[][], firsts?: FirstSig[]): string {
  const arms = branches.map((br, i) => `if (${firstCond(firsts![i], 't')}) { if (${br.length ? br.map(stepCond).join(' && ') : 'true'}) return true; }`).join(' else ');
  return `const t = peek(); if (t === null) return false; ${arms} return false;`;
}

function rdRule(r: RdRule): string {
  if (r.predictive) {
  const arm = (steps: Step[], i: number) => `  ${i === 0 ? 'if' : 'else if'} (${firstCond(r.altFirst[i], 't')}) { const kids: Cst[] = []; if (${steps.map(stepCond).join(' && ')}) return branch(${J(r.cstName)}, kids, save); }`;
  return `function parse${r.name}(): Node | null {
  const save = pos;
  const t = peek(); if (t === null) return null;
${r.alts.map(arm).join(' ')}
  pos = save;
  return null;
}`;
  }
  const alt = (steps: Step[]) =>
    `  { const kids: Cst[] = []; if (${steps.map(stepCond).join(' && ')}) return branch(${J(r.cstName)}, kids, save); pos = save; }`;
  return `function parse${r.name}(): Node | null {
  const save = pos;
${r.alts.map(alt).join('\n')}
  return null;
}`;
}

function prattRule(r: PrattRule, tpl: TplCfg | null): string {
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `  if (t.kind === '$templateHead') { const node = matchTemplate(); return node === null ? null : { rule: ${J(r.cstName)}, children: [node], offset: node.offset, end: node.end }; }\n`
    : '';
  const BIN = `{ ${r.binary.map((b) => `${J(b.op)}: { lbp: ${b.lbp}, rbp: ${b.rbp} }`).join(', ')} }`;
  const PRE = `{ ${r.prefix.map((p) => `${J(p.op)}: ${p.rbp}`).join(', ')} }`;
  const atom = `new Set([${r.nudToks.map(J).join(', ')}])`;
  const bracketNud = (b: Bracket) => `    if (t.text === ${J(b.first)}) {
      const save = pos; const kids: Cst[] = [];
      if (${b.steps.map(stepCond).join(' && ')}) return node(${J(r.cstName)}, kids, t.off);
      pos = save;   // fall through to the next NUD alternative (e.g. another '${b.first}'-led form)
    }`;
  // Access-tail leds (member/call/index) are disabled once a postfix has closed the operand;
  // a precedence-gated led (ternary/in/instanceof) binds only when its lbp > minBp.
  const ledArm = (b: Bracket, accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null) => `    if (${accessTail ? '!tailClosed && ' : ''}${lbp !== null ? `${lbp} > minBp && ` : ''}${sameLine ? '!t.nl && ' : ''}${nll ? `!${J(nll)}.includes(headLeafText(left)) && ` : ''}(_suppressCur === null || !_suppressCur.has(${J(b.first)})) && t.text === ${J(b.first)}) {
      const ledSave = pos; const kids: Cst[] = [left];
      if (${b.steps.map(stepCond).join(' && ')}) { left = node(${J(r.cstName)}, kids); continue; }
      pos = ledSave; break;
    }`;
  // A postfix token (e.g. a tagged template) binds like a mixfix led: `left X` → node(left, X). Also an access tail.
  const postfixArm = (tok: string) => {
    const tplPart = tpl && tok === tpl.token ? `
    if (!tailClosed && t.kind === '$templateHead') { const node = matchTemplate(); if (node !== null) { left = { rule: ${J(r.cstName)}, children: [left, node], offset: left.offset, end: node.end }; continue; } }` : '';
    return `    if (!tailClosed && t.kind === ${J(tok)}) { const leaf: Leaf = { tokenType: t.kind, offset: t.off, end: t.end }; pos++; left = { rule: ${J(r.cstName)}, children: [left, leaf], offset: left.offset, end: leaf.end }; continue; }${tplPart}`;
  };
  const POST = `{ ${r.postfix.map((p) => `${J(p.op)}: ${p.lbp}`).join(', ')} }`;
  return `const ${r.name}_BIN: Record<string, { lbp: number; rbp: number }> = ${BIN};
const ${r.name}_PRE: Record<string, number> = ${PRE};
const ${r.name}_POST: Record<string, number> = ${POST};
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
  for (;;) {
    const t = peek();
    if (t === null) break;
${r.leds.map((b, i) => ledArm(b, r.ledAccessTail[i], r.ledLbp[i], r.ledSameLine[i], r.ledNotLeftLeaf[i])).join('\n')}
${r.postfixToks.map(postfixArm).join('\n')}
    const post = ${r.name}_POST[t.text];
    if (!tailClosed && post !== undefined && post > minBp) { pos++; const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end }; left = { rule: ${J(r.cstName)}, children: [left, opLeaf], offset: left.offset, end: t.end }; tailClosed = true; continue; }
    const info = ${r.name}_BIN[t.text];
    if (info === undefined || info.lbp <= minBp) break;
    const ledSave = pos;
    pos++;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end };
    const rhs = ${r.name}_bp(info.rbp);
    if (rhs === null) { pos = ledSave; break; }
    left = { rule: ${J(r.cstName)}, children: [left, opLeaf, rhs], offset: left.offset, end: rhs.end };
  }
  return left;
}
function ${r.name}_nud(minBp: number): Node | null {
  _capped = false;
  const t = peek();
  if (t === null) return null;
${r.nudCapped.map((c) => `  if (minBp < ${c.capBp}) { const save = pos; const kids: Cst[] = []; if (${c.steps.length ? c.steps.map(stepCond).join(' && ') : 'true'}) { _capped = true; return branch(${J(r.cstName)}, kids, save); } pos = save; }`).join('\n')}
  // Below is non-capped: a sub-parse may leave _capped set (e.g. grouping a capped arrow),
  // so force it false after — only the capped arms above produce a capped node.
  const _r = ((): Node | null => {
${tplNud}  if (${r.name}_ATOM.has(t.kind)) { pos++; return { rule: ${J(r.cstName)}, children: [{ tokenType: t.kind, offset: t.off, end: t.end }], offset: t.off, end: t.end }; }
${r.nudBrackets.map(bracketNud).join('\n')}
  const pbp = ${r.name}_PRE[t.text];
  if (pbp !== undefined) {
    const save = pos; pos++;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end };
    const operand = ${r.name}_bp(pbp);
    if (operand === null) { pos = save; return null; }
    return { rule: ${J(r.cstName)}, children: [opLeaf, operand], offset: t.off, end: operand.end };
  }
${r.nudSeqs.map((seq) => `  { const save = pos; const kids: Cst[] = []; if (${seq.length ? seq.map(stepCond).join(' && ') : 'true'}) return branch(${J(r.cstName)}, kids, save); pos = save; }`).join('\n')}
  return null;
  })();
  _capped = false;
  return _r;
}`;
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
type Tok = { kind: string; text: string; off: number; end: number; nl: boolean };

${lexer(portableIR(grammar))}

export function tokenize(src: string): Tok[] { return lex(src); }
`;
  },
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r, ir.tpl) : rdRule(r))).join('\n\n');
    const matchTemplate = ir.tpl ? `function matchTemplate(): Cst | null {
  const t = peek();
  if (t === null || t.kind !== '$templateHead') return null;
  const children: Cst[] = [];
  const save = pos; pos++;
  children.push({ tokenType: '$templateHead', offset: t.off, end: t.end });
  for (;;) {
    const expr = parse${ir.tpl.interpRule}();
    if (expr === null) { pos = save; return null; }
    children.push(expr);
    const next = peek();
    if (next === null) { pos = save; return null; }
    if (next.kind === '$templateMiddle') { pos++; children.push({ tokenType: '$templateMiddle', offset: next.off, end: next.end }); continue; }
    if (next.kind === '$templateTail') { pos++; children.push({ tokenType: '$templateTail', offset: next.off, end: next.end }); break; }
    pos = save; return null;
  }
  return { rule: '$template', children, offset: children[0].offset, end: children[children.length - 1].end };
}
` : '';
    return `// GENERATED by emit-portable.ts (tsTarget) — parser LIBRARY for grammar "${ir.grammarName}" (exports \`parse\`).
// The CLI runner (stdin → CST JSON) is a SEPARATE piece — tsTarget.emitRunner(), appended by the harness.

type Tok = { kind: string; text: string; off: number; end: number; nl: boolean };
type Leaf = { tokenType: string; offset: number; end: number };
type Node = { rule: string; children: Cst[]; offset: number; end: number };
type Cst = Node | Leaf;

${lexerSrc ?? ''}

let toks: Tok[] = [];
let pos = 0;
let _capped = false;
let _suppressNext: Set<string> | null = null;
let _suppressCur: Set<string> | null = null;
let _src = '';
function peek(): Tok | null { return pos < toks.length ? toks[pos] : null; }
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
function matchLit(value: string, ttype: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.text !== value) return false;
  if (ttype !== '$punct') kids.push({ tokenType: ttype, offset: t.off, end: t.end }); pos++; return true;
}
function matchTok(name: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.kind !== name) return false;
  kids.push({ tokenType: name, offset: t.off, end: t.end }); pos++; return true;
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
function sepBy(elem: () => boolean, delim: string, kids: Cst[]): boolean {
  if (!elem()) return true;   // the whole separated list is optional — zero elements is valid
  for (;;) {
    const sp = pos; const before = kids.length;
    if (!matchLit(delim, '$punct', kids)) { pos = sp; kids.length = before; break; }
    if (!elem()) break;   // a trailing delimiter is allowed — keep the pushed delim and stop
  }
  return true;
}
function altLit(opts: [string, string][], kids: Cst[]): boolean {
  for (const [v, tt] of opts) if (matchLit(v, tt, kids)) return true;
  return false;
}

${matchTemplate}${ruleFns}

// Library entry, in two composable phases. tokenize() lexes ONCE; pass its tokens to parse().
// Want both the token stream and the CST? Lex once: const t = tokenize(src); parse(t) — no
// re-lexing. Want only the CST? parse(tokenize(src)). (tokenize also records the source for
// head-leaf lookups.) No I/O — see emitRunner() for the stdin → JSON wrapper.
export function tokenize(src: string): Tok[] { _src = src; return lex(src); }
export function parse(tokens: Tok[]): Cst | null {
  toks = tokens;
  pos = 0;
  const root = parse${ir.entry}();
  return root !== null && pos === toks.length ? root : null;
}

export type Edit = { start: number; end: number; text: string };
type AlignMeta = { kind: string; off: number; end: number; nl: boolean };
type Align = { oldN: number; newN: number; prefix: number; suffix: number };
const toMeta = (toks: Tok[]): AlignMeta[] => toks.map((t) => ({ kind: t.kind, off: t.off, end: t.end, nl: t.nl }));
function computeAlign(oldText: string, oldToks: AlignMeta[], newText: string, newToks: AlignMeta[]): Align {
  const oldN = oldToks.length, newN = newToks.length;
  let prefix = 0;
  while (prefix < oldN && prefix < newN) {
    const o = oldToks[prefix], n = newToks[prefix];
    if (o.kind !== n.kind || o.off !== n.off || o.end !== n.end || o.nl !== n.nl) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    prefix++;
  }
  const delta = newText.length - oldText.length;
  const minN = Math.min(oldN, newN);
  let suffix = 0;
  while (prefix + suffix < minN) {
    const o = oldToks[oldN - 1 - suffix], n = newToks[newN - 1 - suffix];
    if (o.kind !== n.kind || o.nl !== n.nl || n.off !== o.off + delta || n.end !== o.end + delta) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    suffix++;
  }
  return { oldN, newN, prefix, suffix };
}
export function createDoc(src: string): { text(): string; root(): Node | null; align(): Align | null; edit(edits: Edit[]): Node | null } {
  let text = src;
  let prevToks = toMeta(tokenize(src));
  let align: Align | null = null;
  let root: Node | null = parse(tokenize(src));
  return {
    text(): string { return text; },
    root(): Node | null { return root; },
    align(): Align | null { return align; },
    edit(edits: Edit[]): Node | null {
      const oldText = text, oldToks = prevToks;
      for (const e of edits) {
        const n = text.length, start = Math.max(0, Math.min(e.start, n)), end = Math.max(start, Math.min(e.end, n));
        text = text.slice(0, start) + e.text + text.slice(end);
      }
      const newToks = tokenize(text);
      prevToks = toMeta(newToks);
      align = computeAlign(oldText, oldToks, text, prevToks);
      root = parse(newToks);
      return root;
    },
  };
}
`;
  },
  emitRunner(): string {
    return `// CLI runner (harness only): stdin → CST JSON. Appended to the parser library by the gate;
// NOT part of the emitted parser. The import is hoisted, so it may follow the library code.
import { readFileSync } from 'node:fs';
const _raw = readFileSync(0, 'utf8');
if (process.argv.includes('edit-session')) {
  const { init, batches } = JSON.parse(_raw) as { init: string; batches: [number, number, string][][] };
  const doc = createDoc(init);
  for (const batch of batches) doc.edit(batch.map(([start, end, text]) => ({ start, end, text })));
  const a = doc.align();
  if (a) process.stderr.write(JSON.stringify(a) + '\\n');
  const root = doc.root();
  if (root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(root));
} else {
  const _root = parse(tokenize(_raw));
  if (_root === null) { process.stderr.write('parse error\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(_root));
}
`;
  },
};
