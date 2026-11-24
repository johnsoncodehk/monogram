// The interpreter's VERDICT against the language's own parsers, on small inputs generated from
// each grammar's operator and continuation tables: the defects where every engine is wrong
// together, which no engine-against-engine gate can see (found by it, 2026-11-23: a conditional
// whose last branch is an arrow took a trailing `|| x`; `c ||= a = b` rejected; the `yield` arm
// not capped; TypeScript's `<T> a = c` read as `<T>(a = c)`).
//
// Inputs: every operand form as the left operand of every continuation and inside every operand
// slot, in two statement contexts (`e;`, `x = e;`), a `yield` / `await` form inside an async
// generator; for TypeScript also every type form beside every type continuation and inside every
// type slot, in five type contexts. Oracles: the TypeScript grammar against tsc's parser
// (`parseDiagnostics`: syntactic only); the JavaScript grammar against acorn (script, then
// module) and tsc's JS mode. `--python`: python.ts against `ast.parse` of CPython 3.10.12 (the CI
// job `python` runs that half; its record is test/verdict-scan-python-record.txt).
//
// Every disagreement falls in a recorded CLASS (CLASSES below: its disposition says whose it is).
// Green: no disagreement outside a class, and each class's count is the record's
// (test/verdict-scan-record.txt). A class that grows is a regression; one that shrinks or
// vanishes is a fix, recorded with `--write`, so each fix is visible in the record's diff.
//
// The generator takes a grammar and returns inputs (`verdictInputs`), with no file path in it: the
// corpora layer is to fold it in as the PAIRS feed of the "verdict against the language" property.
//
//   node test/verdict-scan.ts            check against the record
//   node test/verdict-scan.ts --write    re-record
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createParser } from '../src/gen-parser.ts';
import * as acorn from 'acorn';
import ts from 'typescript';
import javascript from '../javascript.ts';
import typescript from '../typescript.ts';
import python from '../python.ts';

export type VerdictInput = { src: string; recipe: string };
type Grammar = { precs: { operators: { value: string; position: string }[] }[]; ledPrecs?: { connector: string }[] };

function ops(g: Grammar) {
  const bin: string[] = [], pre: string[] = [], post: string[] = [];
  for (const lvl of g.precs) for (const o of lvl.operators) {
    const arr = o.position === 'infix' ? bin : o.position === 'prefix' ? pre : post;
    if (!arr.includes(o.value)) arr.push(o.value);
  }
  return { bin, pre: pre.filter((p) => p !== 'await' && p !== 'yield'), post, leds: (g.ledPrecs ?? []).map((l) => l.connector) };
}
const word = (p: string) => /\w$/.test(p);
const prefixed = (p: string, x: string) => (word(p) ? `${p} ${x}` : `${p}${x}`);

function exprForms(g: Grammar, isTs: boolean): Record<string, { src: string; gen?: boolean }> {
  const { pre, post } = ops(g);
  const f: Record<string, { src: string; gen?: boolean }> = {
    ident: { src: 'a' }, num: { src: '1' }, str: { src: '"s"' }, tpl: { src: '`t`' }, tplHole: { src: '`t${a}`' }, regex: { src: '/r/' },
    this: { src: 'this' }, null: { src: 'null' }, array: { src: '[a]' }, object: { src: '{a}' }, paren: { src: '(a)' },
    member: { src: 'a.b' }, index: { src: 'a[b]' }, call: { src: 'a(b)' }, optMember: { src: 'a?.b' }, optCall: { src: 'a?.(b)' },
    tagged: { src: 'a`t`' }, new: { src: 'new a' }, newArgs: { src: 'new a(b)' }, fnExpr: { src: 'function () {}' },
    classExpr: { src: 'class {}' }, assign: { src: 'a = b' }, compound: { src: 'a += b' }, cond: { src: 'a ? b : c' },
    arrowBlock: { src: '() => {}' }, arrowExpr: { src: '() => a' }, arrowId: { src: 'a => a' }, arrowIdBlock: { src: 'a => {}' },
    asyncArrow: { src: 'async () => {}' }, asyncArrowId: { src: 'async a => a' }, importCall: { src: 'import(a)' },
    yieldBare: { src: 'yield', gen: true }, yieldArg: { src: 'yield a', gen: true }, yieldStar: { src: 'yield* a', gen: true },
    yieldArrow: { src: 'yield () => {}', gen: true }, await: { src: 'await a', gen: true },
    condArrow: { src: 'a ? b : () => {}' }, assignArrow: { src: 'a = () => {}' }, binary: { src: 'a + b' }, logical: { src: 'a || b' },
  };
  for (const p of pre) f[`pre${p}`] = { src: prefixed(p, 'a') };
  for (const p of post) f[`post${p}`] = { src: `a${p}` };
  if (isTs) Object.assign(f, {
    as: { src: 'a as T' }, satisfies: { src: 'a satisfies T' }, nonNull: { src: 'a!' }, typeAssert: { src: '<T>a' },
    typeArgsCall: { src: 'f<T>(a)' }, instantiation: { src: 'f<T>' }, typedArrow: { src: '(a: T) => a' }, genericArrow: { src: '<T>(a) => a' },
    retTypeArrow: { src: '(a): T => a' }, retTypeArrowBlock: { src: '(a): T => {}' },
  });
  return f;
}
function exprConts(g: Grammar, isTs: boolean): Record<string, (l: string) => string> {
  const { bin, post, leds } = ops(g);
  const c: Record<string, (l: string) => string> = {};
  for (const op of bin) c[`bin${op}`] = (l) => `${l} ${op} c`;
  for (const p of post) c[`post${p}`] = (l) => `${l}${p}`;
  for (const k of leds) {
    if (k === '?') c.ternary = (l) => `${l} ? c : d`;
    else if (k === 'as' || k === 'satisfies') c[k] = (l) => `${l} ${k} T`;
    else c[k] = (l) => `${l} ${k} c`;
  }
  Object.assign(c, {
    member: (l: string) => `${l}.x`, index: (l: string) => `${l}[c]`, call: (l: string) => `${l}(c)`, optMember: (l: string) => `${l}?.x`,
    tagged: (l: string) => `${l}\`t\``, nlParen: (l: string) => `${l}\n(c)`, nlPlus: (l: string) => `${l}\n+c`, nlIncr: (l: string) => `${l}\n++c`,
  });
  if (isTs) Object.assign(c, { nonNull: (l: string) => `${l}!`, typeArgsCall: (l: string) => `${l}<T>(c)` });
  return c;
}
function exprSlots(g: Grammar): Record<string, (r: string) => string> {
  const { bin, pre, leds } = ops(g);
  const s: Record<string, (r: string) => string> = {};
  for (const op of bin) s[`bin${op}`] = (r) => `c ${op} ${r}`;
  for (const p of pre) s[`pre${p}`] = (r) => prefixed(p, r);
  for (const k of leds) {
    if (k === '?') { s.then = (r) => `c ? ${r} : d`; s.else = (r) => `c ? d : ${r}`; s.test = (r) => `${r} ? c : d`; }
    else if (k === 'in' || k === 'instanceof') s[k] = (r) => `c ${k} ${r}`;
  }
  Object.assign(s, {
    spreadArray: (r: string) => `[...${r}]`, spreadCall: (r: string) => `f(...${r})`, arg: (r: string) => `f(${r})`, element: (r: string) => `[${r}]`,
    index: (r: string) => `c[${r}]`, paren: (r: string) => `(${r})`, hole: (r: string) => `\`\${${r}}\``, prop: (r: string) => `{k: ${r}}`,
    arrowBody: (r: string) => `() => ${r}`, newCallee: (r: string) => `new ${r}`, seq: (r: string) => `${r}, y`,
  });
  return s;
}
const TYPE_FORMS: Record<string, string> = {
  ref: 'A', qual: 'A.B', args: 'A<B>', qualArgs: 'A.B<C>', array: 'A[]', indexed: 'A[K]', keyof: 'keyof A', typeofQ: 'typeof a',
  typeofMember: 'typeof a.b', unique: 'unique symbol', readonlyArr: 'readonly A[]', fn: '() => A', fnParam: '(a: A) => B', ctor: 'new () => A',
  abstractCtor: 'abstract new () => A', union: 'A | B', leadUnion: '| A', inter: 'A & B', paren: '(A)', tuple: '[A]', namedTuple: '[a: A]',
  restTuple: '[...A]', emptyObj: '{}', obj: '{ a: A }', str: '"s"', num: '1', neg: '-1', bool: 'true', void: 'void', null: 'null',
  this: 'this', any: 'any', tpl: '`t${A}`', cond: 'A extends B ? C : D', importT: 'import("m")', importQ: 'import("m").A',
  mapped: '{ [K in A]: B }', fnGeneric: '<T>(a: T) => T',
  infer: 'infer U', inferExt: 'infer U extends A', pred: 'a is A', asserts: 'asserts a', assertsIs: 'asserts a is A',
};
const TYPE_CONTS: Record<string, (l: string) => string> = {
  array: (l) => `${l}[]`, indexed: (l) => `${l}[K]`, member: (l) => `${l}.x`, args: (l) => `${l}<T>`, union: (l) => `${l} | B`,
  inter: (l) => `${l} & B`, cond: (l) => `${l} extends B ? C : D`, nlArray: (l) => `${l}\n[]`,
};
const TYPE_SLOTS: Record<string, (r: string) => string> = {
  union: (r) => `X | ${r}`, inter: (r) => `X & ${r}`, indexed: (r) => `X[${r}]`, keyof: (r) => `keyof ${r}`, fnRet: (r) => `() => ${r}`,
  arg: (r) => `X<${r}>`, tuple: (r) => `[${r}]`, check: (r) => `${r} extends B ? C : D`, ext: (r) => `A extends ${r} ? B : C`,
  then: (r) => `A extends B ? ${r} : C`, else: (r) => `A extends B ? C : ${r}`, inferExt: (r) => `A extends infer U extends ${r} ? B : C`,
  arrayElem: (r) => `${r}[]`, readonly: (r) => `readonly ${r}`,
};
const TYPE_CTX: Record<string, (t: string) => string> = {
  alias: (t) => `type X = ${t};`, annot: (t) => `let x: ${t};`, ret: (t) => `function f(): ${t} {}`, as: (t) => `x as ${t};`,
  inExt: (t) => `type X = A extends ${t} ? B : C;`,
};

// Python: operand forms, continuations and slots in Python's surface syntax; the operators come from
// the grammar's tables as for the others. `fn` places a form that needs a function (`yield`: a def,
// `await`: an async def).
type PyForm = { src: string; fn?: 'def' | 'async' };
function pyForms(g: Grammar): Record<string, PyForm> {
  const { pre } = ops(g);
  const f: Record<string, PyForm> = {
    ident: { src: 'a' }, num: { src: '1' }, float: { src: '1.5' }, imag: { src: '1j' }, str: { src: '"s"' }, bytes: { src: 'b"s"' },
    fstr: { src: 'f"{a}"' }, concat: { src: '"s" "t"' }, none: { src: 'None' }, ellipsis: { src: '...' },
    list: { src: '[a]' }, tuple: { src: '(a, b)' }, empty: { src: '()' }, paren: { src: '(a)' }, dict: { src: '{a: b}' }, set: { src: '{a}' },
    listComp: { src: '[a for a in b]' }, genexp: { src: '(a for a in b)' }, dictComp: { src: '{a: a for a in b}' },
    attr: { src: 'a.b' }, sub: { src: 'a[b]' }, slice: { src: 'a[b:c]' }, call: { src: 'a(b)' }, kwCall: { src: 'a(b=c)' },
    starCall: { src: 'a(*b)' }, lambda: { src: 'lambda: a' }, lambdaArg: { src: 'lambda a: a' }, cond: { src: 'a if b else c' },
    not: { src: 'not a' }, and: { src: 'a and b' }, or: { src: 'a or b' }, cmp: { src: 'a < b' }, chain: { src: 'a < b < c' },
    in: { src: 'a in b' }, notIn: { src: 'a not in b' }, is: { src: 'a is b' }, isNot: { src: 'a is not b' }, walrusParen: { src: '(x := a)' },
    walrus: { src: 'x := a' }, binary: { src: 'a + b' }, power: { src: 'a ** b' }, star: { src: '*a' },
    await: { src: 'await a', fn: 'async' }, yield: { src: 'yield', fn: 'def' }, yieldArg: { src: 'yield a', fn: 'def' },
    yieldFrom: { src: 'yield from a', fn: 'def' },
  };
  for (const p of pre) f[`pre${p}`] = { src: prefixed(p, 'a') };
  return f;
}
function pyConts(g: Grammar): Record<string, (l: string) => string> {
  const { bin, leds } = ops(g);
  const c: Record<string, (l: string) => string> = {};
  for (const op of bin) c[`bin${op}`] = (l) => `${l} ${op} c`;
  for (const k of leds) c[k] = k === 'not' ? (l) => `${l} not in c` : (l) => `${l} ${k} c`;
  Object.assign(c, {
    isNot: (l: string) => `${l} is not c`, attr: (l: string) => `${l}.x`, sub: (l: string) => `${l}[c]`, slice: (l: string) => `${l}[c:d]`,
    call: (l: string) => `${l}(c)`, cond: (l: string) => `${l} if c else d`, and: (l: string) => `${l} and c`, or: (l: string) => `${l} or c`,
    walrus: (l: string) => `${l} := c`, tuple: (l: string) => `${l}, y`, comp: (l: string) => `[${l} for y in z]`,
  });
  return c;
}
function pySlots(g: Grammar): Record<string, { at: (r: string) => string; fn?: 'async' }> {
  const { bin, pre } = ops(g);
  const s: Record<string, { at: (r: string) => string; fn?: 'async' }> = {};
  for (const op of bin) s[`bin${op}`] = { at: (r) => `c ${op} ${r}` };
  for (const p of pre) s[`pre${p}`] = { at: (r) => prefixed(p, r) };
  const plain: Record<string, (r: string) => string> = {
    not: (r) => `not ${r}`, and: (r) => `c and ${r}`, or: (r) => `c or ${r}`, in: (r) => `c in ${r}`, notIn: (r) => `c not in ${r}`,
    body: (r) => `${r} if c else d`, test: (r) => `c if ${r} else d`, else: (r) => `c if d else ${r}`, arg: (r) => `f(${r})`,
    kwArg: (r) => `f(k=${r})`, starArg: (r) => `f(*${r})`, element: (r) => `[${r}]`, starElement: (r) => `[*${r}]`, sub: (r) => `c[${r}]`,
    paren: (r) => `(${r})`, value: (r) => `{k: ${r}}`, lambda: (r) => `lambda: ${r}`, hole: (r) => `f"{${r}}"`, tuple: (r) => `${r}, y`,
    compElt: (r) => `[${r} for y in z]`, compIter: (r) => `[y for y in ${r}]`, compIf: (r) => `[y for y in z if ${r}]`,
    powerBase: (r) => `${r} ** c`,
  };
  for (const [k, at] of Object.entries(plain)) s[k] = { at };
  s.await = { at: (r) => `await ${r}`, fn: 'async' };
  return s;
}

/** The scan's inputs for a grammar of `lang` (TypeScript: the type forms too), each once, with the recipe that made it. */
export function verdictInputs(g: Grammar, lang: 'javascript' | 'typescript' | 'python'): VerdictInput[] {
  const out = new Map<string, string>();
  const add = (src: string, recipe: string) => { if (!out.has(src)) out.set(src, recipe); };
  if (lang === 'python') {
    const forms = pyForms(g), conts = pyConts(g), slots = pySlots(g);
    const fnWrap = (s: string, fn: PyForm['fn']) => (fn ? `${fn === 'async' ? 'async ' : ''}def g():\n    ${s}` : s);
    for (const [fid, f] of Object.entries(forms)) for (const ctx of ['stmt', 'assign'] as const) {
      const wrap = (e: string, fn: PyForm['fn']) => fnWrap(ctx === 'stmt' ? `${e}\n` : `x = ${e}\n`, fn);
      add(wrap(f.src, f.fn), `form:${fid}|${ctx}`);
      for (const [cid, c] of Object.entries(conts)) add(wrap(c(f.src), f.fn), `left:${cid}|${ctx}`);
      for (const [sid, s] of Object.entries(slots)) add(wrap(s.at(f.src), s.fn ?? f.fn), `right:${sid}|${ctx}`);
    }
    // The target positions (python.ts's declared contexts: star, single, del), each holding a form
    // and a form with a continuation: what a node's shape decides, so no operator slot around it.
    const targetAt: Record<string, (e: string) => string> = {
      assignTo: (e) => `${e} = x`, chainTo: (e) => `y = ${e} = x`, augTo: (e) => `${e} += x`, annTo: (e) => `${e}: int`,
      del: (e) => `del ${e}`, forIn: (e) => `for ${e} in x: pass`, compFor: (e) => `[y for ${e} in x]`, withAs: (e) => `with x as ${e}: pass`,
    };
    for (const [fid, f] of Object.entries(forms)) for (const [tid, t] of Object.entries(targetAt)) {
      add(fnWrap(`${t(f.src)}\n`, f.fn), `form:${fid}|${tid}`);
      for (const [cid, c] of Object.entries(conts)) add(fnWrap(`${t(c(f.src))}\n`, f.fn), `left:${cid}|${tid}`);
    }
    return [...out].map(([src, recipe]) => ({ src, recipe }));
  }
  const withTypes = lang === 'typescript';
  const forms = exprForms(g, withTypes), conts = exprConts(g, withTypes), slots = exprSlots(g);
  const wrap = (e: string, gen: boolean | undefined, ctx: 'stmt' | 'assign') => {
    const s = ctx === 'stmt' ? `${e};` : `x = ${e};`;
    return gen ? `async function* g() { ${s} }` : s;
  };
  for (const [fid, f] of Object.entries(forms)) for (const ctx of ['stmt', 'assign'] as const) {
    add(wrap(f.src, f.gen, ctx), `form:${fid}|${ctx}`);
    for (const [cid, c] of Object.entries(conts)) add(wrap(c(f.src), f.gen, ctx), `left:${cid}|${ctx}`);
    for (const [sid, s] of Object.entries(slots)) add(wrap(s(f.src), f.gen, ctx), `right:${sid}|${ctx}`);
  }
  if (withTypes) for (const [fid, f] of Object.entries(TYPE_FORMS)) for (const [xid, x] of Object.entries(TYPE_CTX)) {
    add(x(f), `tform:${fid}|${xid}`);
    for (const [cid, c] of Object.entries(TYPE_CONTS)) add(x(c(f)), `tleft:${cid}|${xid}`);
    for (const [sid, s] of Object.entries(TYPE_SLOTS)) add(x(s(f)), `tright:${sid}|${xid}`);
  }
  return [...out].map(([src, recipe]) => ({ src, recipe }));
}

// ── the classes: whose each disagreement is ──
// A row: the interpreter's verdict (`we`) beside the oracles' (`tsc`: tsc's parser, for Python
// `ast.parse`; `acorn` for JavaScript). A class's `side` is the half of the scan that can produce it.
type Row = { grammar: string; src: string; recipe: string; we: boolean; tsc: boolean; acorn?: boolean };
type Disposition = 'engine' | 'grammar' | 'lexer' | 'policy' | 'oracle-tolerance' | 'oracle-defect';
type Side = 'js' | 'py';
type Class = { id: string; disposition: Disposition; test: (r: Row) => boolean; note: string; side?: Side };
const PY_CLASSES: Class[] = [
  { id: 'py-fstring-fields', disposition: 'lexer', note: 'an f-string is lexed as a plain string: its replacement fields are not parsed (python.ts header)', test: (r) => r.we && /f"\{/.test(r.src) },
  { id: 'py-ann-paren-trailer', disposition: 'grammar', note: 'python.gram annotates `(\'(\' single_target \')\' | single_subscript_attribute_target) \':\'`: a PEG group commits to its first alternative, so `(a).x: int` (a parenthesized single target, then a trailer) has no parse; python.ts\'s single context admits it (it reads the trailer\'s node, not what the trailer applies to)', test: (r) => r.we && !r.tsc && /\|annTo$/.test(r.recipe) && /^\([^,]*\)[.[]/.test(r.src) },
];
const CLASSES: Class[] = [
  { id: 'arrow-body-ctx', disposition: 'grammar', note: 'an arrow ExpressionBody is [~Yield], [~Await]', test: (r) => /=> (yield|await)/.test(r.src) },
  { id: 'coalesce-mix', disposition: 'grammar', note: 'CoalesceExpression: `??` beside `||` / `&&` needs parentheses', test: (r) => /\|\| b \?\?|\?\? a \|\||&& b \?\?|\?\? a &&/.test(r.src) },
  { id: 'number-then-ident', disposition: 'lexer', note: 'a NumericLiteral directly followed by an IdentifierStart (`1.x`)', test: (r) => /(^|[ (=])1\.x/.test(r.src) },
  { id: 'regex-after-update', disposition: 'lexer', note: 'a regex after a prefix `++` / `--` read as division', test: (r) => /(\+\+|--)\/r\//.test(r.src) },
  { id: 'lt-composite', disposition: 'engine', note: '`<<` opening nested type arguments (no `<` split, the mirror of the `>` re-scan)', test: (r) => /<</.test(r.src) && !r.we },
  { id: 'ts-assertion-operand', disposition: 'grammar', note: '`<T> $` takes its operand at bp 0, not as a UnaryExpression', test: (r) => /<T>(a|\(a\))/.test(r.src) && r.we && !r.tsc },
  { id: 'ts-type-args-commit', disposition: 'grammar', note: 'after a type reference tsc commits to `<` type arguments', test: (r) => /(as|satisfies) T <|f<T> \/=/.test(r.src) },
  { id: 'ts-new-import', disposition: 'grammar', note: 'an ImportCall is no MemberExpression', test: (r) => /new import/.test(r.src) },
  { id: 'ts-cond-in-extends', disposition: 'grammar', note: 'no unparenthesized conditional type in an extends position', test: (r) => r.grammar === 'typescript' && /extends .*extends .*\?/.test(r.src) && r.we },
  { id: 'ts-nonref-tail', disposition: 'grammar', note: '`<T>` / `.x` only after a type reference', test: (r) => /^tleft:(args|member)/.test(r.recipe) },
  { id: 'ts-infer-postfix', disposition: 'grammar', note: 'no postfix on `infer U`', test: (r) => /infer U/.test(r.src) && /^tleft/.test(r.recipe) },
  { id: 'ts-fn-in-union', disposition: 'grammar', note: 'a function / constructor type in a union or intersection is parenthesized', test: (r) => /^tright:(union|inter)/.test(r.recipe) },
  { id: 'ts-operator-leading-bar', disposition: 'grammar', note: 'a type operator\'s operand begins no `|` / `&`', test: (r) => /^tright:(keyof|readonly)/.test(r.recipe) },
  { id: 'assign-target-validity', disposition: 'policy', note: 'AssignmentTargetType is static semantics (docs/CORRECTNESS.md): acorn alone rejects', test: (r) => r.we && r.tsc && r.acorn === false && /(=|\+\+|--)/.test(r.src) && !/\?\./.test(r.src) },
  { id: 'assign-to-function', disposition: 'policy', note: 'the left side\'s shape is a LeftHandSideExpression; its validity is static semantics', test: (r) => /function \(\) \{\} =/.test(r.src) },
  { id: 'optional-chain-early-errors', disposition: 'policy', note: 'an optional chain as an update operand / a tag: early errors', test: (r) => /\?\./.test(r.src) && r.we && r.tsc },
  { id: 'statement-class-expr', disposition: 'oracle-tolerance', note: 'ExpressionStatement [lookahead ∉ { class }]: tsc\'s parser reads `class {}` there', test: (r) => /class \{\}/.test(r.src) && !r.we && r.tsc },
  { id: 'acorn-arrow-operand', disposition: 'oracle-defect', note: 'acorn takes an operator after an arrow (`() => {} ? c : d`); an ArrowFunction is no ShortCircuitExpression', test: (r) => !r.we && !r.tsc && r.acorn === true },
];

// The Python oracle is CPython 3.10.12's `ast.parse` (the version test/cpython.ts measures against);
// `MONOGRAM_PYTHON` names it (CI's `python` job sets it), else `python3`.
const PYTHON = process.env.MONOGRAM_PYTHON ?? 'python3';
const WANT_PY = '3.10.12';
const PY_ORACLE = String.raw`
import ast, json, sys, warnings
warnings.simplefilter('ignore')
out = []
for s in json.load(sys.stdin):
    try:
        ast.parse(s); out.append(True)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        out.append(False)
json.dump(out, sys.stdout)
`;

const RECORDS: Record<Side, string> = {
  js: new URL('./verdict-scan-record.txt', import.meta.url).pathname,
  py: new URL('./verdict-scan-python-record.txt', import.meta.url).pathname,
};

function scanJs(): { n: number; rows: Row[] } {
  const tscOk = (src: string, js: boolean) => {
    const sf = ts.createSourceFile(js ? 'a.js' : 'a.ts', src, ts.ScriptTarget.Latest, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    return (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
  };
  const acornOk = (src: string) => {
    for (const sourceType of ['script', 'module'] as const) { try { acorn.parse(src, { ecmaVersion: 'latest', sourceType }); return true; } catch { /* the next */ } }
    return false;
  };
  const rows: Row[] = [];
  let n = 0;
  for (const [name, g] of [['javascript', javascript], ['typescript', typescript]] as const) {
    const p = createParser(g);
    const we = (src: string) => { try { p.parse(src); return true; } catch { return false; } };
    for (const { src, recipe } of verdictInputs(g as unknown as Grammar, name)) {
      n++;
      const w = we(src), t = tscOk(src, name === 'javascript');
      if (name === 'typescript') { if (w !== t) rows.push({ grammar: name, src, recipe, we: w, tsc: t }); }
      else { const a = acornOk(src); if (w !== a || w !== t) rows.push({ grammar: name, src, recipe, we: w, tsc: t, acorn: a }); }
    }
  }
  return { n, rows };
}

function scanPy(): { n: number; rows: Row[] } | string {
  let v = '';
  try { v = execFileSync(PYTHON, ['-I', '-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).trim(); } catch { /* reported */ }
  if (v !== WANT_PY) return `the oracle must be Python ${WANT_PY} (${PYTHON} is ${v || 'absent'}; set MONOGRAM_PYTHON)`;
  const inputs = verdictInputs(python as unknown as Grammar, 'python');
  const ref: boolean[] = JSON.parse(execFileSync(PYTHON, ['-I', '-c', PY_ORACLE], { input: JSON.stringify(inputs.map((i) => i.src)), encoding: 'utf8', maxBuffer: 1 << 26 }));
  const p = createParser(python);
  const rows: Row[] = [];
  inputs.forEach(({ src, recipe }, i) => {
    let w = true;
    try { p.parse(src); } catch { w = false; }
    if (w !== ref[i]) rows.push({ grammar: 'python', src, recipe, we: w, tsc: ref[i]! });
  });
  return { n: inputs.length, rows };
}

function main(): void {
  const t0 = Date.now();
  const side: Side = process.argv.includes('--python') ? 'py' : 'js';
  const classes = side === 'py' ? PY_CLASSES : CLASSES;
  const RECORD = RECORDS[side];
  const scanned = side === 'py' ? scanPy() : scanJs();
  if (typeof scanned === 'string') { console.log(`✗ NOT RUN: ${scanned}`); process.exit(1); }
  const { n, rows } = scanned;
  const by = new Map<string, Row[]>(), outside: Row[] = [];
  for (const r of rows) {
    const c = classes.find((k) => k.test(r));
    if (!c) { outside.push(r); continue; }
    if (!by.has(c.id)) by.set(c.id, []);
    by.get(c.id)!.push(r);
  }
  const shortest = (rs: Row[]) => [...rs].sort((a, b) => a.src.length - b.src.length || (a.src < b.src ? -1 : 1))[0]!;
  const list = process.argv.indexOf('--list');
  if (list > 0) {   // --list <class id | outside>: every row of one class, for reading
    const id = process.argv[list + 1];
    for (const r of id === 'outside' ? outside : by.get(id!) ?? []) console.log(`${r.grammar}\tours=${r.we}\toracle=${r.tsc}${r.acorn === undefined ? '' : `\tacorn=${r.acorn}`}\t${r.recipe}\t${JSON.stringify(r.src)}`);
    return;
  }
  const lines = classes.filter((c) => by.has(c.id)).map((c) => `${c.id}\t${c.disposition}\t${by.get(c.id)!.length}\t${JSON.stringify(shortest(by.get(c.id)!).src)}`);
  const text = `# test/verdict-scan.ts${side === 'py' ? ' --python' : ''}: class, disposition, count, shortest witness (re-record: add --write)\n${lines.join('\n')}\n`;
  const summary = `${n} inputs, ${rows.length} disagreements in ${by.size} classes, ${Date.now() - t0} ms`;
  if (process.argv.includes('--write')) {
    if (outside.length) { for (const r of outside) console.log(`outside every class: ${r.grammar} ours=${r.we} ${r.recipe} ${JSON.stringify(r.src)}`); process.exit(1); }
    writeFileSync(RECORD, text); console.log(`recorded: ${summary}`); return;
  }
  const rec = new Map((existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const [id, , count] = l.split('\t'); return [id!, Number(count)]; }));
  const bad: string[] = outside.map((r) => `outside every class (${r.grammar}, interpreter ${r.we ? 'accepts' : 'rejects'}): ${JSON.stringify(r.src)}`);
  for (const c of classes) {
    const now = by.get(c.id)?.length ?? 0, was = rec.get(c.id) ?? 0;
    if (now > was) bad.push(`class ${c.id} (${c.disposition}) grew ${was} -> ${now}: ${JSON.stringify(shortest(by.get(c.id)!).src)}`);
    if (now < was) bad.push(`class ${c.id} (${c.disposition}) shrank ${was} -> ${now}: a fix. A landing that fixes a class re-records the scan in the same landing: ${side === 'py' ? 'node --stack-size=7000 test/verdict-scan.ts --python --write (with MONOGRAM_PYTHON = CPython 3.10.12, as the python CI job has)' : 'node test/verdict-scan.ts --write'}; the diff of the record is the evidence`);
  }
  if (bad.length) { for (const b of bad.slice(0, 40)) console.log(`✗ ${b}`); if (bad.length > 40) console.log(`… ${bad.length - 40} more`); console.log(summary); process.exit(1); }
  console.log(`✓ verdicts against ${side === 'py' ? 'ast.parse' : 'tsc / acorn'} match the record: ${summary}`);
}
if (import.meta.main) main();

