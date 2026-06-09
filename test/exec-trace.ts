// ─────────────────────────────────────────────────────────────────────────────
//  exec-trace.ts — flattened execution-path tracer (standalone; debug-only).
//
//  Prints the ACTUAL source executed between startTrace()/endTrace(), flattened across
//  call boundaries, with the runtime value of each step and a cost tag — the basis for
//  op-by-op review of whether each branch/op is minimal.
//
//  It does NOT touch the production parser: it AST-instruments a copy (TS compiler API)
//  so every statement-expression / initializer / return / condition records (line, text,
//  value, cost) into a buffer gated on a global flag the markers flip. Markers in the real
//  source (src/trace-markers.ts) are near-free no-ops; here they bound what gets printed.
//
//    node test/exec-trace.ts                       # gen-parser.ts on "a + b" (entry Expr)
//    node test/exec-trace.ts "<input>" <entry>     # custom input / entry rule
//    node test/exec-trace.ts "<input>" <entry> <src/file.ts>
// ─────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

const REPO = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const input = pos[0] ?? 'a + b';
const entry = pos[1] ?? 'Expr';
const target = resolve(REPO, pos[2] ?? 'src/gen-parser.ts');
// Optional spatial scope: only record ops on lines A..B (focus on a region without
// editing the source; the time-region startTrace/endTrace markers are the other knob).
const linesArg = args.find(a => a.startsWith('--lines='));
const [LO, HI] = linesArg ? linesArg.slice(8).split('-').map(Number) : [0, Infinity];

// ── 1) cost classification (transform-time) ──
function costOf(node: ts.Node): string {
  let cost = '';
  const scan = (n: ts.Node): void => {
    if (cost) return;
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;        // don't peer into nested fns
    if (ts.isNewExpression(n) || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) { cost = 'alloc'; return; }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && /^(get|set|has|add|delete)$/.test(callee.name.text)) cost = `map.${callee.name.text}`;
      else cost = 'call';
      return;
    }
    ts.forEachChild(n, scan);
  };
  ts.forEachChild(node, scan);
  if (!cost && (ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))) cost = 'alloc';
  return cost;
}

// ── 2) instrument ──
const source = readFileSync(target, 'utf-8');
const sf = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const textOf = (n: ts.Node) => {
  // For a declaration show `name = init` (drop the `: Type` annotation — pure noise).
  let raw = ts.isVariableDeclaration(n) ? `${n.name.getText(sf)} = ${n.initializer ? n.initializer.getText(sf) : ''}` : n.getText(sf);
  raw = raw.replace(/\s+/g, ' ');
  return raw.length > 64 ? raw.slice(0, 63) + '…' : raw;
};

const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const f = context.factory;
  const G = (m: string) => f.createPropertyAccessExpression(f.createIdentifier('globalThis'), m);
  const num = (n: number) => f.createNumericLiteral(n);
  const str = (s: string) => f.createStringLiteral(s);
  // __recv(line, text, cost, expr) → records the value, returns expr unchanged (single eval).
  const recv = (l: number, t: string, c: string, e: ts.Expression) =>
    f.createCallExpression(G('__recv'), undefined, [num(l), str(t), str(c), e]);
  const recc = (l: number, t: string, e: ts.Expression) =>
    f.createCallExpression(G('__recc'), undefined, [num(l), str(t), e]);
  const enterStmt = (l: number, name: string) =>
    f.createExpressionStatement(f.createCallExpression(G('__enter'), undefined, [num(l), str(name)]));
  const exitStmt = (l: number) =>
    f.createExpressionStatement(f.createCallExpression(G('__exit'), undefined, [num(l)]));

  const isFnExpr = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e);

  const visit = (node: ts.Node): ts.Node => {
    // capture original line/text BEFORE children are replaced
    if (ts.isExpressionStatement(node)) {
      const l = lineOf(node.expression), t = textOf(node.expression), c = costOf(node.expression);
      const v = ts.visitEachChild(node, visit, context);
      return f.updateExpressionStatement(v, recv(l, t, c, v.expression));
    }
    if (ts.isVariableDeclaration(node) && node.initializer && !isFnExpr(node.initializer)) {
      const l = lineOf(node), t = textOf(node), c = costOf(node.initializer);
      const v = ts.visitEachChild(node, visit, context) as ts.VariableDeclaration;
      return f.updateVariableDeclaration(v, v.name, v.exclamationToken, v.type, recv(l, t, c, v.initializer!));
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const l = lineOf(node), t = textOf(node), c = costOf(node.expression);
      const v = ts.visitEachChild(node, visit, context) as ts.ReturnStatement;
      return f.updateReturnStatement(v, recv(l, t, c, v.expression!));
    }
    if (ts.isIfStatement(node)) {
      const l = lineOf(node.expression), t = textOf(node.expression);
      const v = ts.visitEachChild(node, visit, context) as ts.IfStatement;
      return f.updateIfStatement(v, recc(l, t, v.expression), v.thenStatement, v.elseStatement);
    }
    if (ts.isWhileStatement(node)) {
      const l = lineOf(node.expression), t = textOf(node.expression);
      const v = ts.visitEachChild(node, visit, context) as ts.WhileStatement;
      return f.updateWhileStatement(v, recc(l, t, v.expression), v.statement);
    }
    // Frame boundaries (named function declarations — the parser's functions): enter marker
    // + try/finally exit so every call is exactly one balanced ▸…◂ frame (early returns,
    // throws, fall-through all hit the finally). Gated on the FN's line so a --lines scope
    // drops a frame's enter+exit together (stays balanced).
    if (ts.isFunctionDeclaration(node) && node.body && node.name) {
      const l = lineOf(node), name = node.name.text;
      const v = ts.visitEachChild(node, visit, context) as ts.FunctionDeclaration;
      const tryFin = f.createTryStatement(f.createBlock(v.body!.statements, true), undefined, f.createBlock([exitStmt(l)], true));
      const body = f.createBlock([enterStmt(l, name), tryFin], true);
      return f.updateFunctionDeclaration(v, v.modifiers, v.asteriskToken, v.name, v.typeParameters, v.parameters, v.type, body);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (root) => ts.visitNode(root, visit) as ts.SourceFile;
};

const result = ts.transform(sf, [transformer]);
let printed = ts.createPrinter().printFile(result.transformed[0]);
// absolutize relative imports so the /tmp copy resolves the real sibling modules
printed = printed.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (_m, q, p) => `from ${q}${resolve(dirname(target), p)}${q}`);

const outPath = '/tmp/exec-trace-instrumented.ts';
writeFileSync(outPath, printed);

// ── 3) record runtime ──
type Ev =
  | { kind: 'op'; l: number; t: string; c: string; v?: string }
  | { kind: 'enter'; l: number; fn: string }
  | { kind: 'exit'; l: number };
const TRACE: Ev[] = [];
const g = globalThis as Record<string, unknown>;
g.__REC = false;
g.__TRACE = TRACE;
function fmt(v: unknown): string {
  if (v === null) return '∅';
  if (v === undefined) return '⊥';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 24 ? JSON.stringify(v.slice(0, 24)) + '…' : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Set) return `Set(${v.size})`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.tokenType !== undefined) return `${o.tokenType}@${o.offset}..${o.end}`;
    if (o.rule !== undefined) return `node(${o.rule})`;
    if ('type' in o && 'text' in o) return `${o.type || 'punct'}'${o.text}'`;
    return `{${Object.keys(o).slice(0, 4).join(',')}}`;
  }
  if (typeof v === 'function') return 'fn';
  return String(v);
}
const on = (l: number) => g.__REC && l >= LO && l <= HI;
g.__recv = (l: number, t: string, c: string, v: unknown) => { if (on(l)) TRACE.push({ kind: 'op', l, t, c, v: fmt(v) }); return v; };
g.__recc = (l: number, t: string, v: unknown) => { if (on(l)) TRACE.push({ kind: 'op', l, t, c: 'cond', v: fmt(v) }); return v; };
g.__enter = (l: number, fn: string) => { if (on(l)) TRACE.push({ kind: 'enter', l, fn }); };
g.__exit = (l: number) => { if (on(l)) TRACE.push({ kind: 'exit', l }); };

const mod = await import(pathToFileURL(outPath).href);
const grammar = (await import(pathToFileURL(resolve(REPO, 'typescript.ts')).href)).default;
const parser = mod.createParser(grammar);

g.__REC = true;
let err: string | null = null;
try { parser.parse(input, entry); } catch (e) { err = (e as Error).message; }
g.__REC = false;

// ── 4) build frame tree → group by DISTINCT execution path → render ──
const fileName = target.replace(REPO + '/', '');
const ops = TRACE.filter((e): e is Extract<Ev, { kind: 'op' }> => e.kind === 'op');
const allocs = ops.filter(e => e.c === 'alloc').length;
const mapset = ops.filter(e => e.c.startsWith('map.')).length;
const conds = ops.filter(e => e.c === 'cond').length;
const calls = TRACE.filter(e => e.kind === 'enter').length;

type OpN = { op: true; l: number; t: string; c: string; vs: (string | undefined)[]; n: number };
type FrameN = { op: false; fn: string; l: number; items: Node[]; n: number };
type Node = OpN | FrameN;

// events → tree (enter pushes a frame, exit pops; try/finally keeps them balanced)
const root: FrameN = { op: false, fn: '(root)', l: 0, items: [], n: 1 };
const stack: FrameN[] = [root];
for (const e of TRACE) {
  const top = stack[stack.length - 1];
  if (e.kind === 'enter') { const fr: FrameN = { op: false, fn: e.fn, l: e.l, items: [], n: 1 }; top.items.push(fr); stack.push(fr); }
  else if (e.kind === 'exit') { if (stack.length > 1) stack.pop(); }
  else top.items.push({ op: true, l: e.l, t: e.t, c: e.c, vs: [e.v], n: 1 });
}

// path signature: same path ⇔ same op/frame structure (values excluded — they aggregate)
const sig = (n: Node): string => n.op ? `o${n.l}:${n.t}` : `f${n.fn}:${n.l}(${n.items.map(sig).join(',')})`;
// merge same-signature nodes: concat op value-lists, recurse frames position-wise (same sig ⇒ same shape)
function merge(ns: Node[]): Node {
  const total = ns.reduce((s, x) => s + x.n, 0);
  if (ns[0].op) { const f = ns[0]; return { op: true, l: f.l, t: f.t, c: f.c, vs: (ns as OpN[]).flatMap(x => x.vs), n: total }; }
  const f0 = ns[0] as FrameN;
  return { op: false, fn: f0.fn, l: f0.l, items: f0.items.map((_, i) => merge((ns as FrameN[]).map(x => x.items[i]))), n: total };
}
// group a sibling list by signature (first-occurrence order), then recurse into frames
function group(items: Node[]): Node[] {
  const order: string[] = []; const by = new Map<string, Node[]>();
  for (const it of items) { const s = sig(it); if (!by.has(s)) { by.set(s, []); order.push(s); } by.get(s)!.push(it); }
  return order.map(s => { const m = merge(by.get(s)!); if (!m.op) m.items = group(m.items); return m; });
}

const valDist = (vs: (string | undefined)[]) => {
  if (vs[0] === undefined) return '';
  const c = new Map<string, number>();
  for (const v of vs) c.set(v!, (c.get(v!) ?? 0) + 1);
  return c.size === 1 ? ` → ${[...c.keys()][0]}` : ` → ${[...c].map(([v, k]) => `${v}×${k}`).join(' ')}`;
};
const out: string[] = [];
const render = (ns: Node[], d: number) => {
  const ind = '  '.repeat(d);
  for (const n of ns) {
    const rep = n.n > 1 ? ` ×${n.n}` : '';
    if (n.op) out.push(`${ind}${n.l} ${n.t}${valDist(n.vs)}${n.c && n.c !== 'cond' ? ` {${n.c}}` : ''}${rep}`);
    else { out.push(`${ind}▸${n.fn}${rep}`); render(n.items, d + 1); }
  }
};
render(group(root.items), 0);

console.log(`═ ${fileName} · ${JSON.stringify(input)} (entry ${entry}) ═`);
console.log(`summary: ${TRACE.length} ops · ${calls} calls · ${allocs} alloc · ${mapset} map/set · ${conds} cond${err ? ` · ERROR ${err}` : ''}`);
console.log(`fmt: [indent=call depth] line source → value(×N if varies) {cost} · ▸fn ×N = N calls, one DISTINCT path  (bare line=${fileName})`);
console.log(out.join('\n'));
