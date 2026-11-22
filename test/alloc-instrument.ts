// Exact allocation counting for an emitted TypeScript / JavaScript parser (test/alloc-work.ts).
//
// `instrument(source)` rewrites the module so that every expression that creates a heap value
// reports it: object and array literals, closures (arrow / function expressions, and function
// declarations nested in a function, created once per call of the enclosing one), `new X(...)`,
// calls that return a fresh array or string (`.slice()`, `.map()`, `.substring()`, ...), template
// strings with substitutions, string `+`, and rest parameters (an array per call). Array GROWTH is
// counted too: every `x.push(...)` reports the array, and the count of backing-store growths
// follows V8's rule (a full array grows to new_length + new_length/2 + 16 slots), starting from the
// array's creation (a literal holds its elements, `.slice()`/`.map()` their length, an array first
// seen at a push its length). Counting is by site; a site's key is its kind and its normalized
// source text, so the same code in a thousand rule functions is one site.
//
// Bytes are MODELED from V8's layout with pointer compression (a heap object header is 12 bytes,
// a field 4): object 12 + 4 × max(own properties, 4) (an empty literal reserves 4 in-object slots);
// array 16, plus a backing store of 8 + 4 × capacity; closure 32; string of n one-byte characters
// 12 + n rounded up to 4 when flat (n < 13 or not a slice / concatenation), 20 for a sliced or cons
// string; Map / Set 16 + 8 + 4 × (3 + 3 × 8) for the initial table; typed array 64 + its bytes; any
// other `new` 28; a RegExp match 28 + its backing store + its capture strings. Not seen: closure
// contexts, iterators of `for...of` and destructuring (optimized code usually removes them),
// numbers boxed as heap doubles. The model is deterministic, so a record of it is exact; the measured
// `heapUsed` delta beside it says how close it is.
import ts from 'typescript';

export type Kind = 'object' | 'array' | 'closure' | 'string' | 'map/set' | 'typed array' | 'other new' | 'array growth' | 'rest array';
export type SiteInfo = { key: string; kind: string; text: string; fns: Set<string> };

const FRESH_CALLS = new Set(['slice', 'map', 'filter', 'concat', 'split', 'substring', 'substr', 'join', 'trim', 'toLowerCase',
  'toUpperCase', 'replace', 'replaceAll', 'padStart', 'padEnd', 'repeat', 'flat', 'flatMap', 'from', 'of', 'keys', 'values',
  'entries', 'fromCharCode', 'fromCodePoint', 'stringify', 'toString', 'charAt', 'exec', 'match', 'matchAll']);

export function instrument(source: string, fileName: string): { code: string; sites: SiteInfo[] } {
  const sites: SiteInfo[] = [];
  const byKey = new Map<string, number>();
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fnName = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf);
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText(sf);
      if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText(sf);
    }
    return '(module)';
  };
  const site = (n: ts.Node, kind: string): number => {
    let text = n.getText(sf).replace(/\s+/g, ' ');
    if (text.length > 70) text = text.slice(0, 67) + '...';
    // Rule functions differ only in the rule's name / ids: fold string and number literals so the
    // same code shape in every rule function is one site.
    const shape = text.replace(/"[^"]*"|'[^']*'/g, '"…"').replace(/\b\d+\b/g, 'N');
    const key = kind + '|' + shape;
    let id = byKey.get(key);
    if (id === undefined) { id = sites.length; byKey.set(key, id); sites.push({ key, kind, text: shape, fns: new Set() }); }
    sites[id]!.fns.add(fnName(n));
    return id;
  };
  const f = ts.factory;
  const call = (name: string, args: ts.Expression[]) => f.createCallExpression(f.createIdentifier(name), undefined, args);
  const num = (x: number) => f.createNumericLiteral(x);
  const insideFunction = (n: ts.Node) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true; return false; };
  const simpleTarget = (e: ts.Expression): boolean => ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(e) && simpleTarget(e.expression));

  const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const visit = (n: ts.Node): ts.Node => {
      // Types and declarations without values allocate nothing at run time.
      if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return n;
      // A function body: count rest parameters and nested function declarations per call.
      if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body && ts.isBlock((n as ts.FunctionLikeDeclaration).body!)) {
        const fn = n as ts.FunctionLikeDeclaration;
        const pre: ts.Statement[] = [];
        for (const p of fn.parameters) if (p.dotDotDotToken) pre.push(f.createExpressionStatement(call('__A', [num(site(p, 'rest array')), p.name as ts.Identifier])));
        for (const s of (fn.body as ts.Block).statements) if (ts.isFunctionDeclaration(s) && s.name && insideFunction(s)) pre.push(f.createExpressionStatement(call('__A', [num(site(s.name, 'closure')), s.name])));
        const out = ts.visitEachChild(n, visit, ctx) as ts.FunctionLikeDeclaration;
        if (!pre.length) return out;
        const body = out.body as ts.Block;
        // Function declarations hoist: their counter can run first.
        const nb = f.updateBlock(body, [...pre, ...body.statements]);
        if (ts.isFunctionDeclaration(out)) return f.updateFunctionDeclaration(out, out.modifiers, out.asteriskToken, out.name, out.typeParameters, out.parameters, out.type, nb);
        if (ts.isFunctionExpression(out)) return f.updateFunctionExpression(out, out.modifiers, out.asteriskToken, out.name, out.typeParameters, out.parameters, out.type, nb);
        if (ts.isArrowFunction(out)) return wrapClosure(n, f.updateArrowFunction(out, out.modifiers, out.typeParameters, out.parameters, out.type, out.equalsGreaterThanToken, nb));
        if (ts.isMethodDeclaration(out)) return f.updateMethodDeclaration(out, out.modifiers, out.asteriskToken, out.name, out.questionToken, out.typeParameters, out.parameters, out.type, nb);
        return out;
      }
      if (ts.isObjectLiteralExpression(n)) return call('__A', [num(site(n, 'object')), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      if (ts.isArrayLiteralExpression(n)) return call('__A', [num(site(n, 'array')), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return wrapClosure(n, ts.visitEachChild(n, visit, ctx) as ts.Expression);
      if (ts.isNewExpression(n)) return call('__A', [num(site(n, 'new ' + n.expression.getText(sf))), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      if (ts.isTemplateExpression(n)) return call('__A', [num(site(n, 'string')), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return call('__S', [num(site(n, '+')), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && ts.isIdentifier(n.left)) {
        const r = ts.visitEachChild(n, visit, ctx) as ts.BinaryExpression;
        return f.createAssignment(r.left, call('__S', [num(site(n, '+')), f.createAdd(r.left, f.createParenthesizedExpression(r.right))]));
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        if (name === 'push' && simpleTarget(n.expression.expression)) {
          const id = site(n, 'array growth');
          const r = ts.visitEachChild(n, visit, ctx) as ts.CallExpression;
          const tgt = (r.expression as ts.PropertyAccessExpression).expression;
          // push returns the new length: the growth check runs after it, the arguments once.
          return call('__G', [num(id), tgt, r]);
        }
        if (FRESH_CALLS.has(name)) return call('__F', [num(site(n, '.' + name + '()')), ts.visitEachChild(n, visit, ctx) as ts.Expression]);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)
        && n.left.name.text === 'length' && simpleTarget(n.left.expression)) {
        const r = ts.visitEachChild(n, visit, ctx) as ts.BinaryExpression;
        return call('__L', [(r.left as ts.PropertyAccessExpression).expression, r]);
      }
      return ts.visitEachChild(n, visit, ctx);
    };
    const wrapClosure = (orig: ts.Node, e: ts.Expression) => call('__A', [num(site(orig, 'closure')), e]);
    return (s) => ts.visitNode(s, visit) as ts.SourceFile;
  };
  const r = ts.transpileModule(source, {
    fileName, transformers: { before: [transformer] },
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true, verbatimModuleSyntax: false },
  });
  return { code: PRELUDE + r.outputText, sites };
}

// The counters the instrumented module calls. `globalThis.__alloc` is the state; `on` arms it.
const PRELUDE = `
const __st = globalThis.__alloc;
const __cap = new WeakMap();
function __model(v, how) {
  if (typeof v === 'string') return (v.length >= 13 && how !== 'flat') ? 20 : (12 + ((v.length + 3) & ~3));
  // A RegExp match: an array with index / input / groups, and a string per capture.
  if (Array.isArray(v) && 'index' in v) { let b = 28 + 8 + 4 * v.length; for (const x of v) if (typeof x === 'string') b += __model(x, 'slice'); return b; }
  if (Array.isArray(v)) return 16 + (v.length ? 8 + 4 * v.length : 0);
  if (typeof v === 'function') return 32;
  if (v instanceof Map || v instanceof Set) return 16 + 8 + 4 * 27;
  if (ArrayBuffer.isView(v)) return 64 + v.byteLength;
  if (v && typeof v === 'object') { const n = Object.keys(v).length; return Object.getPrototypeOf(v) === Object.prototype ? 12 + 4 * Math.max(n, 4) : 28; }
  return 0;
}
function __type(v) {
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'function') return 'closure';
  if (v instanceof Map || v instanceof Set) return 'map/set';
  if (ArrayBuffer.isView(v)) return 'typed array';
  return 'object';
}
function __hit(id, v, how) {
  const t = __type(v), k = id + '\\t' + t;
  const c = __st.counts.get(k);
  const b = __model(v, how);
  if (c) { c.n++; c.bytes += b; } else __st.counts.set(k, { n: 1, bytes: b });
  if (typeof v === 'object' && v !== null || typeof v === 'function') __st.site.set(v, id);
}
function __A(id, v) {
  if (__st.on) { __hit(id, v, 'flat'); if (Array.isArray(v)) __cap.set(v, v.length); }
  return v;
}
function __F(id, v) {
  if (__st.on && (typeof v === 'string' || (typeof v === 'object' && v !== null))) { __hit(id, v, 'slice'); if (Array.isArray(v)) __cap.set(v, v.length); }
  return v;
}
function __S(id, v) {
  if (__st.on && typeof v === 'string') __hit(id, v, 'cons');
  return v;
}
function __G(id, a, need) {
  if (!__st.on || !Array.isArray(a)) return need;
  const cap = __cap.get(a);
  if (cap === undefined) { __cap.set(a, need); return need; } // first seen here: its capacity is unknown, count no growth
  if (need > cap) {
    const nc = need + (need >> 1) + 16;
    __cap.set(a, nc);
    const key = id + '\\tarray growth';
    const c = __st.counts.get(key);
    if (c) { c.n++; c.bytes += 8 + 4 * nc; } else __st.counts.set(key, { n: 1, bytes: 8 + 4 * nc });
  }
  return need;
}
function __L(a, v) { if (__st.on && Array.isArray(a) && a.length === 0) __cap.set(a, 0); return v; }
`;
