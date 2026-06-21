// The TypeScript Target for emit-portable. Renders the language-agnostic ParserIR into a
// self-contained TS parser: a char-class/string/comment lexer, a backtracking recursive-
// descent core, a Pratt expression engine (prefix + binary precedence + mixfix call/member/
// index LEDs), and a CST→JSON printer over stdin. It is the reference rendering — its CST
// is checked byte-for-byte against the interpreter (createParser), so a divergence in the
// portable logic surfaces here before Go/Rust are compiled.
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, Target } from './emit-portable.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} === ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

import type { TokenPattern } from './types.ts';

// Compile a token-pattern AST to backtracking-free matcher functions `_mN(p): number`
// (returns the new position, or -1 on no match). Greedy `repeat`, ordered `alt`,
// zero-width `lookahead`/`anchor` — the regex-free token-matcher tier.
function ccCond(p: Extract<TokenPattern, { type: 'charClass' }>): string {
  const parts = p.items.map((it) =>
    it.type === 'char' ? `cc === ${it.value.charCodeAt(0)}` : `cc >= ${it.from.charCodeAt(0)} && cc <= ${it.to.charCodeAt(0)}`);
  const inSet = parts.length === 1 ? parts[0] : '(' + parts.join(' || ') + ')';
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

function scanTok(t: LexTok, defs: string[]): string {
  const name = (t as { name: string }).name;
  const push = (endExpr: string) => (t.skip ? '' : `toks.push({ kind: ${J(name)}, text: src.slice(pos, ${endExpr}), off: pos, end: ${endExpr} }); `);
  if (t.kind === 'run') return `    if (${rangeCond('c', t.first)}) {
      let e = pos + 1;
      while (e < n) { const cc = src.charCodeAt(e); if (!${rangeCond('cc', t.cont)}) break; e++; }
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'string') return `    if (c === ${t.delim.charCodeAt(0)}) {
      let e = pos + 1;
      while (e < n) { const ch = src.charCodeAt(e); if (ch === 92) { e += 2; continue; } if (ch === ${t.delim.charCodeAt(0)}) { e++; break; } e++; }
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'line') return `    if (src.startsWith(${J(t.prefix)}, pos)) {
      let e = pos + ${t.prefix.length};
      while (e < n && src.charCodeAt(e) !== 10) e++;
      ${push('e')}pos = e; continue;
    }`;
  if (t.kind === 'block') return `    if (src.startsWith(${J(t.open)}, pos)) {
      let e = pos + ${t.open.length};
      while (e < n && !src.startsWith(${J(t.close)}, e)) e++;
      if (e < n) e += ${t.close.length};
      ${push('e')}pos = e; continue;
    }`;
  const m = compilePat(t.pattern, defs);
  return `    { const e = ${m}(pos); if (e > pos) { ${push('e')}pos = e; continue; } }`;
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const toks = ir.tokens.map((t) => scanTok(t, defs)).join('\n');
  const puncts = ir.puncts.map((p) =>
    `    if (src.startsWith(${J(p)}, pos)) { toks.push({ kind: '', text: ${J(p)}, off: pos, end: pos + ${p.length} }); pos += ${p.length}; continue; }`).join('\n');
  return `${defs.length ? 'let _s = "";\n' + defs.join('\n') + '\n' : ''}function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let pos = 0;
${defs.length ? '  _s = src;\n' : ''}  while (pos < n) {
    const c = src.charCodeAt(pos);
    if (c === 32 || c === 9 || c === 10 || c === 13) { pos++; continue; }
${toks}
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
    case 'star': return `star(() => ${stepCond(s.step)}, kids)`;
    case 'opt': return `opt(() => ${s.steps.map(stepCond).join(' && ')}, kids)`;
    case 'sep': return `sepBy(() => ${stepCond(s.elem)}, ${J(s.delim)}, kids)`;
    case 'altlit': return `altLit([${s.opts.map((o) => `[${J(o.value)}, ${J(o.ttype)}]`).join(', ')}], kids)`;
  }
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) =>
    `  { const kids: Cst[] = []; if (${steps.map(stepCond).join(' && ')}) return branch(${J(r.name)}, kids, save); pos = save; }`;
  return `function parse${r.name}(): Node | null {
  const save = pos;
${r.alts.map(alt).join('\n')}
  return null;
}`;
}

function prattRule(r: PrattRule): string {
  const BIN = `{ ${r.binary.map((b) => `${J(b.op)}: { lbp: ${b.lbp}, rbp: ${b.rbp} }`).join(', ')} }`;
  const PRE = `{ ${r.prefix.map((p) => `${J(p.op)}: ${p.rbp}`).join(', ')} }`;
  const atom = `new Set([${r.nudToks.map(J).join(', ')}])`;
  const bracketNud = (b: Bracket) => `    if (t.text === ${J(b.first)}) {
      const save = pos; const kids: Cst[] = [];
      if (${b.steps.map(stepCond).join(' && ')}) return node(${J(r.name)}, kids);
      pos = save; return null;
    }`;
  const ledArm = (b: Bracket) => `    if (t.text === ${J(b.first)}) {
      const ledSave = pos; const kids: Cst[] = [left];
      if (${b.steps.map(stepCond).join(' && ')}) { left = node(${J(r.name)}, kids); continue; }
      pos = ledSave; break;
    }`;
  return `const ${r.name}_BIN: Record<string, { lbp: number; rbp: number }> = ${BIN};
const ${r.name}_PRE: Record<string, number> = ${PRE};
const ${r.name}_ATOM = ${atom};
function parse${r.name}(): Node | null { return ${r.name}_bp(0); }
function ${r.name}_bp(minBp: number): Node | null {
  let left = ${r.name}_nud();
  if (left === null) return null;
  for (;;) {
    const t = peek();
    if (t === null) break;
${r.leds.map(ledArm).join('\n')}
    const info = ${r.name}_BIN[t.text];
    if (info === undefined || info.lbp <= minBp) break;
    const ledSave = pos;
    pos++;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end };
    const rhs = ${r.name}_bp(info.rbp);
    if (rhs === null) { pos = ledSave; break; }
    left = { rule: ${J(r.name)}, children: [left, opLeaf, rhs], offset: left.offset, end: rhs.end };
  }
  return left;
}
function ${r.name}_nud(): Node | null {
  const t = peek();
  if (t === null) return null;
  if (${r.name}_ATOM.has(t.kind)) { pos++; return { rule: ${J(r.name)}, children: [{ tokenType: t.kind, offset: t.off, end: t.end }], offset: t.off, end: t.end }; }
${r.nudBrackets.map(bracketNud).join('\n')}
  const pbp = ${r.name}_PRE[t.text];
  if (pbp !== undefined) {
    const save = pos; pos++;
    const opLeaf: Leaf = { tokenType: '$operator', offset: t.off, end: t.end };
    const operand = ${r.name}_bp(pbp);
    if (operand === null) { pos = save; return null; }
    return { rule: ${J(r.name)}, children: [opLeaf, operand], offset: t.off, end: operand.end };
  }
  return null;
}`;
}

export const tsTarget: Target = {
  name: 'typescript',
  ext: 'ts',
  render(ir: ParserIR): string {
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r) : rdRule(r))).join('\n\n');
    return `// GENERATED by emit-portable.ts (tsTarget) — parser for grammar "${ir.grammarName}".
import { readFileSync } from 'node:fs';

type Tok = { kind: string; text: string; off: number; end: number };
type Leaf = { tokenType: string; offset: number; end: number };
type Node = { rule: string; children: Cst[]; offset: number; end: number };
type Cst = Node | Leaf;

${lexer(ir)}

let toks: Tok[] = [];
let pos = 0;
function peek(): Tok | null { return pos < toks.length ? toks[pos] : null; }
function branch(rule: string, kids: Cst[], save: number): Node {
  const offset = kids.length > 0 ? kids[0].offset : (save < toks.length ? toks[save].off : 0);
  const end = kids.length > 0 ? kids[kids.length - 1].end : offset;
  return { rule, children: kids, offset, end };
}
function node(rule: string, kids: Cst[]): Node {
  return { rule, children: kids, offset: kids[0].offset, end: kids[kids.length - 1].end };
}
function matchLit(value: string, ttype: string, kids: Cst[]): boolean {
  const t = peek();
  if (t === null || t.text !== value) return false;
  kids.push({ tokenType: ttype, offset: t.off, end: t.end }); pos++; return true;
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
  if (!elem()) return false;
  for (;;) { const sp = pos; const before = kids.length; if (matchLit(delim, '$punct', kids) && elem()) continue; pos = sp; kids.length = before; break; }
  return true;
}
function altLit(opts: [string, string][], kids: Cst[]): boolean {
  for (const [v, tt] of opts) if (matchLit(v, tt, kids)) return true;
  return false;
}

${ruleFns}

const src = readFileSync(0, 'utf8');
toks = lex(src);
pos = 0;
const root = parse${ir.entry}();
if (root === null || pos !== toks.length) {
  process.stderr.write('parse error (pos ' + pos + '/' + toks.length + ')\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(root));
`;
  },
};
