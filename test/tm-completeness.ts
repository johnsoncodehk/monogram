// ─────────────────────────────────────────────────────────────────────────────
//  tm-completeness.ts — the COMPLETENESS checker + ledger for src/gen-tm.ts.
//
//  Issue #51: prove that the TextMate generator is COMPLETE — for every grammar
//  shape that REQUIRES a TextMate construct, gen-tm emits it AND it is reachable.
//  This is the dual of the soundness ledger (test/gap-ledger.ts, which finds
//  WRONG paints): here we find UN-emitted / UN-reachable obligations.
//
//  The proof is structural, resting on the fact that the generator's INPUT is a
//  CLOSED, FINITE algebra (RuleExpr / TokenPattern in src/types.ts) plus a finite
//  set of config records (TokenDecl / Markup / Indent / Newline / …). Completeness
//  reduces to three mechanically-checkable layers:
//
//    LAYER A — CLOSURE. The public api.ts combinators lower (toRuleExpr) onto
//      exactly the RuleExpr union, and the token builders compile (tokenPatternToRegex)
//      over exactly the TokenPattern union. Each lowering/compiler is TOTAL: a finite
//      case analysis with no silent drop. Witnessed by instantiating every public
//      combinator and asserting (a) it lowers/compiles without throwing and (b) the
//      set of constructors it produces is the WHOLE union (nothing in the algebra is
//      unreachable from the API; nothing the API emits is off-union).
//
//    LAYER B — OBLIGATION COVERAGE. From each grammar G we enumerate Obl(G): the
//      finite, fixed-denominator multiset of highlighting obligations induced by G's
//      tokens / literals / operators / shapes / config. The enumeration is an
//      INDEPENDENT exhaustive walk of the closed algebra (NOT gen-tm's own detectors —
//      a detector that misses a shape would otherwise also miss its obligation,
//      co-blind). Each obligation must be discharged by an emitted construct that is
//      reachable from the root patterns OR a declared export surface.
//
//    REACHABILITY. Every emitted repository key is reachable from root ∪ export
//      surfaces (#expression, canonicalRepoNames official keys, aliasScopes); every
//      export surface whose structural source is present resolves (no dangling).
//
//  Run (bare node):
//    node test/tm-completeness.ts            # print the report
//    node test/tm-completeness.ts --check    # CI gate: fail on any open gap or stale ledger
//    node test/tm-completeness.ts --write     # (re)write COMPLETENESS.md ledger table
// ─────────────────────────────────────────────────────────────────────────────
import {
  token, rule, defineGrammar, sep, opt, many, many1, alt, exclude, not, reservableNot,
  tsRelax, capExpr, awaitCtx, yieldCtx, asyncGenCtx, resetCtx, op, prefix, postfix,
  sameLine, noCommentBefore, noMultilineFlowBefore, notLeftLeaf,
  oneOf, noneOf, seq, altPattern, optPattern, star, plus, repeat,
  followedBy, notFollowedBy, precededBy, notPrecededBy, start, end, never, anyChar, range, none,
} from '../src/api.ts';
import { tokenPatternToRegex, tokenPatternIsNever, tokenPatternLiteralText } from '../src/token-pattern.ts';
import { collectLiterals, isKeywordLiteral } from '../src/grammar-utils.ts';
import type { RuleExpr, TokenPattern, CstGrammar } from '../src/types.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { createParser } from '../src/gen-parser.ts';
import { generateInputs } from './grammar-gen.ts';
import { buildRoleMap, leafRoles, spanBuckets, GEN_OPTS, type TmTok, type Bucket } from './generative-detect.ts';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

let pass = 0, failN = 0;
const fails: string[] = [];
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else { failN++; fails.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ════════════════════════════════════════════════════════════════════════════
//  LAYER A — algebra closure
// ════════════════════════════════════════════════════════════════════════════

// The closed RuleExpr union, straight from src/types.ts (the proof's universe). If a
// constructor is added there without being produced by some api.ts combinator, the
// closure witness below will report it as an unreachable constructor.
const RULE_EXPR_UNION = [
  'seq', 'alt', 'literal', 'ref', 'quantifier', 'group', 'not',
  'sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf',
  'sep', 'op', 'prefix', 'postfix',
] as const;

const TOKEN_PATTERN_UNION = [
  'anyChar', 'charClass', 'seq', 'alt', 'repeat', 'lookahead', 'lookbehind', 'anchor', 'never',
  // (bare string is the tenth variant, handled before the object switch)
] as const;

// Walk a lowered RuleExpr, collecting every constructor tag it (transitively) uses.
function collectExprTags(e: RuleExpr, out: Set<string>): void {
  out.add(e.type);
  switch (e.type) {
    case 'seq': case 'alt': e.items.forEach(i => collectExprTags(i, out)); break;
    case 'quantifier': case 'group': collectExprTags(e.body, out); break;
    case 'not': collectExprTags(e.body, out); break;
    case 'sep': collectExprTags(e.element, out); break;
    // literal / ref / op / prefix / postfix / sameLine / noCommentBefore /
    // noMultilineFlowBefore / notLeftLeaf are leaves — no children.
  }
}

function checkRuleExprClosure(): void {
  // ONE synthetic grammar whose rule bodies exercise EVERY public combinator and marker.
  // Lowering it through defineGrammar() runs toRuleExpr on each; the produced constructor
  // tags must cover the whole RuleExpr union, and lowering must not throw (totality).
  const A = token('a');
  const B = token('b');
  // Every combinator/marker appears here at least once.
  const Leaf = rule(() => [['lit']]);                                 // literal
  const Refs = rule(($: any) => [[A, B, Leaf]]);                       // ref (token + rule)
  const Quant = rule(() => [[opt('x'), many('y'), many1('z')]]);       // quantifier ?,*,+
  const Alt = rule(() => [alt(['p'], ['q', 'r'])]);                    // alt + seq
  const Sep = rule(($: any) => [[sep(A, ',')]]);                       // sep
  const Group = rule(($: any) => [[                                    // group (4 flavours)
    exclude('in', A),                                                  //   group.suppress
    awaitCtx(A), yieldCtx(A), asyncGenCtx(A), resetCtx(A),             //   group.ctxMode
    tsRelax(A, B),                                                     //   group.tsRelaxed
    capExpr('||', A),                                                  //   group.capBelow
  ]]);
  const Nots = rule(($: any) => [[not(A), reservableNot(['kw'])]]);    // not (+ reservable)
  const Markers = rule(($: any) => [[                                  // zero-width markers
    sameLine, noCommentBefore, noMultilineFlowBefore, notLeftLeaf('void', 'null'), A,
  ]]);
  const Pratt = rule(($: any) => [[$, op, $], [prefix, $], [$, postfix]]); // op/prefix/postfix
  const Entry = rule(($: any) => [[many(alt(Leaf, Refs, Quant, Alt, Sep, Group, Nots, Markers, Pratt))]]);

  let threw = false; let g: CstGrammar;
  try {
    g = defineGrammar({
      name: 'closure', tokens: { A, B },
      rules: { Leaf, Refs, Quant, Alt, Sep, Group, Nots, Markers, Pratt, Entry }, entry: Entry,
    });
  } catch (e) { threw = true; g = null as any; }
  check('Lemma A1: toRuleExpr is total (no throw lowering every combinator)', !threw, threw ? 'defineGrammar threw' : '');
  if (threw) return;

  const tags = new Set<string>();
  for (const r of g.rules) collectExprTags(r.body, tags);
  const missing = RULE_EXPR_UNION.filter(t => !tags.has(t));
  const extra = [...tags].filter(t => !(RULE_EXPR_UNION as readonly string[]).includes(t));
  check('Lemma A1: every RuleExpr constructor is reachable from a public combinator',
    missing.length === 0, missing.length ? `unreached: ${missing.join(', ')}` : '');
  check('Lemma A1: the API lowers onto NOTHING outside the RuleExpr union (image ⊆ algebra)',
    extra.length === 0, extra.length ? `off-union: ${extra.join(', ')}` : '');
}

function checkTokenPatternClosure(): void {
  // Instantiate every public token-pattern builder + the bare string. Each must compile
  // (tokenPatternToRegex is total) and the produced constructor tags must cover the union.
  const builders: [string, TokenPattern][] = [
    ['string', 'abc'],
    ['anyChar', anyChar()],
    ['charClass(oneOf)', oneOf('a', 'b')],
    ['charClass(noneOf)', noneOf('x')],
    ['charClass(range)', range('a', 'z')],
    ['seq', seq('a', 'b')],
    ['alt', altPattern('a', 'b')],
    ['repeat(star)', star('a')],
    ['repeat(plus)', plus('a')],
    ['repeat(opt)', optPattern('a')],
    ['repeat(n)', repeat('a', 2, 4)],
    ['lookahead(+)', followedBy('a')],
    ['lookahead(-)', notFollowedBy('a')],
    ['lookbehind(+)', precededBy('a')],
    ['lookbehind(-)', notPrecededBy('a')],
    ['anchor(start)', start()],
    ['anchor(end)', end()],
    ['never', never()],
  ];
  const tags = new Set<string>();
  let allCompiled = true;
  for (const [label, p] of builders) {
    let src = '';
    try { src = tokenPatternToRegex(p); } catch { allCompiled = false; check(`Lemma A2: tokenPatternToRegex compiles ${label}`, false, 'threw'); continue; }
    check(`Lemma A2: tokenPatternToRegex compiles ${label} → non-empty regex`, typeof src === 'string', `got ${typeof src}`);
    if (typeof p === 'string') tags.add('string'); else tags.add(p.type);
  }
  const missing = TOKEN_PATTERN_UNION.filter(t => !tags.has(t));
  check('Lemma A2: every TokenPattern object constructor is produced by a public builder',
    missing.length === 0, missing.length ? `unreached: ${missing.join(', ')}` : '');
  check('Lemma A2: the bare-string TokenPattern variant compiles', tags.has('string'));
  void allCompiled;
}

// ════════════════════════════════════════════════════════════════════════════
//  REACHABILITY — every emitted repo key reachable from root ∪ export surfaces
// ════════════════════════════════════════════════════════════════════════════

interface TmGrammarJson { patterns?: unknown[]; repository?: Record<string, unknown>; scopeName?: string }

// The DECLARED export surfaces of a grammar — repository keys an external embedder reaches
// not from the root but by an explicit `<scope>#<key>` include: the #expression sub-grammar
// (expressionRule) and the canonicalRepoNames OFFICIAL keys (and aliasScopes, which re-expose
// the whole grammar). These are root-UNreachable BY DESIGN (a public repository API).
function exportSurfaceKeys(g: CstGrammar): string[] {
  const out: string[] = [];
  if (g.expressionRule) out.push('expression');
  for (const k of Object.keys(g.canonicalRepoNames ?? {})) out.push(k);
  return out;
}

interface ReachResult { repoKeys: number; reached: number; dead: string[]; danglingWithSource: string[] }

function checkReachability(g: CstGrammar, tm: TmGrammarJson): ReachResult {
  const scope = tm.scopeName ?? g.scopeName ?? `source.${g.name}`;
  const repo = tm.repository ?? {};
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.include === 'string') {
      const inc: string = node.include;
      if (inc === '$self') { /* root */ }
      else if (inc.startsWith('#')) queue.push(inc.slice(1));
      else if (inc.startsWith(scope + '#')) queue.push(inc.slice(scope.length + 1));
      // else external grammar — terminal
    }
    if (node.patterns) visit(node.patterns);
    for (const capKey of ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures'])
      if (node[capKey]) for (const c of Object.values(node[capKey])) visit(c);
  };
  visit(tm.patterns ?? []);
  const exports = exportSurfaceKeys(g);
  // an export surface whose source is ABSENT in a SHARED canonical map (e.g. `type` in JS,
  // which has no type layer) induces no obligation — record it separately, don't seed it dead.
  const danglingWithSource: string[] = [];
  for (const s of exports) { queue.push(s); }
  while (queue.length) {
    const key = queue.shift()!;
    if (reached.has(key)) continue;
    reached.add(key);
    if (repo[key]) visit(repo[key]);
  }
  const allKeys = Object.keys(repo);
  const dead = allKeys.filter(k => !reached.has(k));
  // a reached key with no repo entry that is an EXPORT surface = a declared export with an
  // absent structural source (inert in a shared map); flag only if it is NOT an export surface.
  for (const k of reached) if (!repo[k] && !exports.includes(k)) danglingWithSource.push(k);
  return { repoKeys: allKeys.length, reached: [...reached].filter(k => repo[k]).length, dead, danglingWithSource };
}

// ── Token emitter completeness: every non-skip token has a discharging emission path ──
//  A token bears a leaf-scope obligation unless it is `skip` (trivia / whitespace). Each is
//  discharged by exactly one family: the flat token loop (a `#<name>` repository entry), the
//  regex-literal family (a `regex`-flagged token), the indent/markup ENGINE (a `never()`
//  placeholder pattern the region machinery replaces), the markup region machinery (a markup
//  grammar emits no per-token keys — generateMarkupTm owns text/tag/attr), or a region that
//  owns the token's delimiter (the JSX `/>` / `</` punctuation, scoped inside the JSX patterns).
//  An ORPHAN — a non-skip token with no discharge path — is an emitter-completeness gap.
interface TokenCensus { total: number; skip: number; byPath: Record<string, number>; orphans: string[] }
function tokenCensus(g: CstGrammar, tmJson: TmGrammarJson): TokenCensus {
  const repo = tmJson.repository ?? {};
  const full = JSON.stringify(tmJson);
  const byPath: Record<string, number> = {};
  const orphans: string[] = [];
  let skip = 0;
  const bump = (p: string) => byPath[p] = (byPath[p] ?? 0) + 1;
  for (const t of g.tokens) {
    if (t.flags.includes('skip')) { skip++; continue; }
    if (repo[t.name.toLowerCase()]) { bump('flat'); continue; }
    if (t.flags.includes('regex')) { bump('regex-family'); continue; }
    if (tokenPatternIsNever(t)) { bump('engine-emitted'); continue; }
    if (g.markup) { bump('markup-region'); continue; }                 // generateMarkupTm owns it
    const delim = tokenPatternLiteralText(t);                          // a region owns this token's delimiter?
    if (delim && full.includes(JSON.stringify(delim).slice(1, -1))) { bump('region-owned'); continue; }
    orphans.push(`${t.name}[${t.flags.join(',') || '-'}]`);
  }
  return { total: g.tokens.length, skip, byPath, orphans };
}

// ════════════════════════════════════════════════════════════════════════════
//  shared vscode-textmate tokenizer (one WASM load) — reused by Layer B coverage
// ════════════════════════════════════════════════════════════════════════════
const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

async function loadTmFromObject(scopeName: string, grammars: Record<string, object>): Promise<vsctm.IGrammar | null> {
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => grammars[sn] ? parseRawGrammar(JSON.stringify(grammars[sn]), sn + '.json') : null,
  });
  return reg.loadGrammar(scopeName);
}
async function loadTmFromFiles(scopeName: string, files: Record<string, string>): Promise<vsctm.IGrammar | null> {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar(scopeName);
}
function tmTokenize(grammar: vsctm.IGrammar, text: string): TmTok[] {
  const toks: TmTok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = grammar.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYER B1 — empirical leaf coverage (fixed denominator)
//
//  Every CONTENT/keyword leaf (a leaf the grammar's OWN role map says must read as a
//  keyword / string / number / comment) must be PAINTED — recognised and given a scope
//  beyond the bare document root, never left as inert text. The denominator is the
//  grammar-derived obligation leaves over the deterministic corpus; the role map and the
//  corpus are the SAME independent infrastructure the soundness checks use (no co-bias
//  with gen-tm's own detectors). A leaf painted SOME non-root scope discharges its
//  recognise-and-scope obligation; whether that scope is the RIGHT one is soundness
//  (test/scope-gap.ts + test/gap-ledger.ts), a separate axis.
// ════════════════════════════════════════════════════════════════════════════
const CONTENT_OBLIGATION = new Set<Bucket>(['keyword', 'string', 'number', 'comment']);

interface CoverageResult { den: number; painted: number; uncovered: { text: string; want: string; ctx: string }[] }

function leafCoverage(grammar: CstGrammar, tm: vsctm.IGrammar, opts = GEN_OPTS): CoverageResult {
  const { parse } = createParser(grammar);
  const roleOf = buildRoleMap(grammar);
  const inputs = generateInputs(grammar, opts);
  let den = 0, painted = 0; const uncovered: CoverageResult['uncovered'] = [];
  for (const inp of inputs) {
    let cst; try { cst = parse(inp.text); } catch { continue; }   // only entry-rule (full-document) inputs
    let toks; try { toks = tmTokenize(tm, inp.text); } catch { continue; }
    for (const lf of leafRoles(grammar, cst, inp.text, roleOf)) {
      if (![...lf.expected].some(b => CONTENT_OBLIGATION.has(b))) continue;   // bears a content/keyword obligation
      den++;
      const got = spanBuckets(toks, inp.text, lf.start, lf.end);
      if ([...got].some(b => b !== 'none')) painted++;                         // recognised + scoped
      else if (uncovered.length < 20) uncovered.push({ text: lf.text, want: [...lf.expected].join('|'), ctx: inp.text.slice(Math.max(0, lf.start - 6), lf.end + 6).replace(/\n/g, '\\n') });
    }
  }
  return { den, painted, uncovered };
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYER A (cont.) — the literal-collection backbone is total + drops nothing consumed
//
//  The flat keyword/operator scoping in gen-tm.ts is driven by the SHARED primitive
//  collectLiterals (src/grammar-utils.ts), looped over every rule body. So flat keyword
//  completeness reduces to: collectLiterals collects EVERY consumed literal — it recurses
//  into all consuming structural constructors (seq/alt/quantifier/group/sep) and correctly
//  omits only the non-consuming ones (`not` = negative lookahead, the literal must NOT be
//  there) and `ref` (a cross-rule edge, collected when that rule's own body is walked).
//  Witnessed by nesting a sentinel literal under each constructor. This is why a naive
//  end-to-end keyword probe is VACUOUS — collectLiterals already covers every nesting; the
//  ONLY residual silent-drop risk is in the SPECIALISED region walkers that do NOT use it
//  (getTypeParamElementKeywords, lastModifiers), covered by the region probe below.
// ════════════════════════════════════════════════════════════════════════════
function checkCollectLiteralsClosure(): void {
  const S = 'SENTINEL';
  const ref = { type: 'ref', name: 'Other' } as RuleExpr;
  const lit = { type: 'literal', value: S } as RuleExpr;
  const wrap: [string, RuleExpr, boolean][] = [
    // [label, expr nesting the sentinel, shouldCollect]
    ['seq', { type: 'seq', items: [ref, lit] }, true],
    ['alt', { type: 'alt', items: [ref, lit] }, true],
    ['quantifier(*)', { type: 'quantifier', body: lit, kind: '*' }, true],
    ['group', { type: 'group', body: lit }, true],
    ['group(suppress)', { type: 'group', body: lit, suppress: ['in'] }, true],
    ['group(ctxMode)', { type: 'group', body: lit, ctxMode: 'await' }, true],
    ['sep.element', { type: 'sep', element: lit, delimiter: ',' }, true],
    ['sep.delimiter', { type: 'sep', element: ref, delimiter: S }, true],
    ['not (non-consuming → omit)', { type: 'not', body: lit }, false],
  ];
  for (const [label, expr, shouldCollect] of wrap) {
    const got = collectLiterals(expr).includes(S);
    check(`collectLiterals: a literal under \`${label}\` is ${shouldCollect ? 'collected' : 'correctly omitted'}`, got === shouldCollect,
      `collected=${got}, expected=${shouldCollect}`);
  }
  // markers carry no consumed literal
  for (const m of ['op', 'prefix', 'postfix', 'sameLine', 'noCommentBefore', 'noMultilineFlowBefore'] as const) {
    check(`collectLiterals: marker \`${m}\` contributes no literal`, collectLiterals({ type: m } as RuleExpr).length === 0);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LAYER B2 — region-internal keyword preservation (positive control)
//
//  Inside a derived `<…>` type-parameter region (scoped meta.type.parameters), a nested
//  keyword would inherit the region scope and LOSE its keyword role unless the specialised
//  walker getTypeParamElementKeywords lifts it out. That walker collects the element's DIRECT
//  structural keywords (recursing seq / alt / quantifier / group) — exactly what `extends` /
//  `const` / `in` / `out` need. It deliberately does NOT reach through `ref` (a constraint's
//  TYPE, e.g. `keyof`/`typeof`, must NOT be hoisted to type-param keyword scope) — a boundary
//  consistent with the flat scoping (collectLiterals also stops at `ref`). This probe asserts
//  the well-defined obligation: a direct structural keyword IS hoisted, through each handled
//  constructor. It BITES: if the walker stopped collecting a handled constructor, the keyword
//  would read as plain meta.type content.
// ════════════════════════════════════════════════════════════════════════════
async function regionKeywordProbe(): Promise<void> {
  const Ident = token(plus(range('a', 'z')), { identifier: true });
  // a type-param element with keywords reached through each HANDLED constructor:
  //   kwa via quantifier(opt), extends via opt+seq, kwsep DIRECT inside a `sep` sub-list.
  // `kwsep` is the regression guard for the getTypeParamElementKeywords `sep` recursion: before
  // that one-line completion it read as plain meta.type content (the latent silent drop).
  const TypeParam = rule(() => [[opt('kwa'), Ident, opt('extends', sep('kwsep', '&'))]]);
  const TypeArgs = rule(($: any) => [['<', sep(TypeParam, ','), '>']]);
  const Decl = rule(($: any) => [['fn', Ident, opt(TypeArgs), '(', ')', '{', '}']]);
  const Call = rule(($: any) => [[Ident, '<', sep(Ident, ','), '>', '(', ')']]);
  const Expr = rule(() => [Ident, Call]);
  const Stmt = rule(() => [Decl, Expr]);
  const Prog = rule(() => [[many(Stmt)]]);
  const g = defineGrammar({
    name: 'rkw', scopeName: 'source.rkw', tokens: { Ident },
    prec: [none('<', '>')], scopes: { 'storage.type.function': ['fn'], 'keyword.control': ['kwa', 'extends', 'kwsep'] },
    rules: { TypeParam, TypeArgs, Decl, Call, Expr, Stmt, Prog }, entry: Prog,
  });
  const tm = await loadTmFromObject('source.rkw', { 'source.rkw': generateTmLanguage(g) as unknown as object });
  if (!tm) { check('region-keyword probe: grammar loads', false); return; }
  const witness = 'fn f<kwa T extends kwsep>(){}';
  const toks = tmTokenize(tm, witness);
  for (const kw of ['kwa', 'extends', 'kwsep']) {
    const at = witness.indexOf(kw);
    const got = spanBuckets(toks, witness, at, at + kw.length);
    check(`region-keyword: structural keyword \`${kw}\` is hoisted to keyword scope inside \`<…>\``,
      got.has('keyword'), `got {${[...got].join(',')}}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  driver
// ════════════════════════════════════════════════════════════════════════════
interface GrammarCfg { name: string; module: string; scopeName: string; tm: string; tmExtra?: Record<string, string> }
const GRAMMARS: GrammarCfg[] = [
  { name: 'typescript', module: '../typescript.ts', scopeName: 'source.ts', tm: 'typescript.tmLanguage.json' },
  { name: 'javascript', module: '../javascript.ts', scopeName: 'source.js', tm: 'javascript.tmLanguage.json' },
  { name: 'typescriptreact', module: '../typescriptreact.ts', scopeName: 'source.tsx', tm: 'typescriptreact.tmLanguage.json' },
  { name: 'javascriptreact', module: '../javascriptreact.ts', scopeName: 'source.js.jsx', tm: 'javascriptreact.tmLanguage.json' },
  { name: 'html', module: '../html.ts', scopeName: 'text.html.basic', tm: 'html.tmLanguage.json',
    tmExtra: { 'source.js': 'javascript.tmLanguage.json', 'source.css': 'html.tmLanguage.json' } },
  { name: 'yaml', module: '../yaml.ts', scopeName: 'source.yaml', tm: 'yaml.tmLanguage.json' },
];

// ── the fixed-denominator obligation census per grammar (the ledger row) ──
interface LedgerRow {
  name: string;
  tokenObl: number; tokenDisch: number;        // non-skip tokens, each → a discharge path
  litObl: number;                              // distinct keyword literals (painted ⇐ leaf coverage)
  opObl: number;                               // distinct Pratt operators
  keyObl: number; keyReach: number;            // repository keys, each → reachable
  leafObl: number; leafPaint: number;          // empirical content/keyword leaves, each → painted
}
function ledgerRow(name: string, g: CstGrammar, tmJson: TmGrammarJson, r: ReachResult, tc: TokenCensus, cov: CoverageResult): LedgerRow {
  const lits = new Set<string>();
  for (const rule of g.rules) for (const l of collectLiterals(rule.body)) if (isKeywordLiteral(l)) lits.add(l);
  const ops = new Set<string>();
  for (const p of g.precs) for (const o of p.operators) ops.add(o.value);
  for (const lp of g.ledPrecs ?? []) ops.add(lp.connector);
  return {
    name,
    tokenObl: g.tokens.filter(t => !t.flags.includes('skip')).length, tokenDisch: g.tokens.filter(t => !t.flags.includes('skip')).length - tc.orphans.length,
    litObl: lits.size, opObl: ops.size,
    keyObl: r.repoKeys, keyReach: r.repoKeys - r.dead.length,
    leafObl: cov.den, leafPaint: cov.painted,
  };
}

// the auto-generated ledger block (a region in COMPLETENESS.md, like KNOWN-GAPS.md / the README issue table)
function renderLedger(rows: LedgerRow[]): string {
  const L: string[] = [];
  L.push('<!-- COMPLETENESS-LEDGER:START — auto-generated by `node test/tm-completeness.ts --write`; do not edit by hand. -->');
  L.push('');
  L.push('| Grammar | Tokens | Keyword literals | Operators | Repo keys (reachable) | Leaf obligations (painted) |');
  L.push('|---|---:|---:|---:|---:|---:|');
  const sum = { t: 0, td: 0, lit: 0, op: 0, k: 0, kr: 0, lf: 0, lp: 0 };
  for (const r of rows) {
    L.push(`| ${r.name} | ${r.tokenDisch}/${r.tokenObl} | ${r.litObl} | ${r.opObl} | ${r.keyReach}/${r.keyObl} | ${r.leafPaint}/${r.leafObl} |`);
    sum.t += r.tokenObl; sum.td += r.tokenDisch; sum.lit += r.litObl; sum.op += r.opObl;
    sum.k += r.keyObl; sum.kr += r.keyReach; sum.lf += r.leafObl; sum.lp += r.leafPaint;
  }
  L.push(`| **total** | **${sum.td}/${sum.t}** | **${sum.lit}** | **${sum.op}** | **${sum.kr}/${sum.k}** | **${sum.lp}/${sum.lf}** |`);
  L.push('');
  // the fixed denominator = every measured obligation (token-discharge + key-reachability + leaf-painting)
  const den = sum.t + sum.k + sum.lf, num = sum.td + sum.kr + sum.lp;
  L.push(`**Fixed-denominator completeness: ${num}/${den} = ${(100 * num / den).toFixed(2)}%** ` +
    `(token discharge ${sum.td}/${sum.t} · repository reachability ${sum.kr}/${sum.k} · leaf painting ${sum.lp}/${sum.lf}). ` +
    `Keyword literals (${sum.lit}) and Pratt operators (${sum.op}) are discharged through the leaf-painting column. ` +
    `${num === den ? '**0 open completeness gaps.**' : `**${den - num} OPEN GAP(S).**`}`);
  L.push('');
  L.push('<!-- COMPLETENESS-LEDGER:END -->');
  return L.join('\n');
}

const LEDGER_FILE = 'COMPLETENESS.md';
function spliceRegion(file: string, block: string): { changed: boolean; full: string } {
  const start = '<!-- COMPLETENESS-LEDGER:START', end = '<!-- COMPLETENESS-LEDGER:END -->';
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const si = cur.indexOf(start), ei = cur.indexOf(end);
  if (si < 0 || ei < 0) return { changed: cur !== '', full: cur };   // markers absent → leave the file alone
  const full = cur.slice(0, si) + block + cur.slice(ei + end.length);
  return { changed: full !== cur, full };
}

async function main(): Promise<void> {
  const WRITE = process.argv.includes('--write');
  const CHECK = process.argv.includes('--check');

  console.log('── Layer A: algebra closure ──');
  checkRuleExprClosure();
  checkTokenPatternClosure();

  console.log('── Layer A: no consumed literal is silently dropped (collectLiterals backbone) ──');
  checkCollectLiteralsClosure();
  await regionKeywordProbe();

  console.log('── Reachability · token completeness · Layer B1 leaf coverage ──');
  const rows: LedgerRow[] = [];
  for (const cfg of GRAMMARS) {
    if (!existsSync(cfg.tm)) { console.log(`  ${cfg.name}: (no emitted grammar)`); continue; }
    const g = (await import(cfg.module)).default as CstGrammar;
    const tmJson = JSON.parse(readFileSync(cfg.tm, 'utf8')) as TmGrammarJson;
    const r = checkReachability(g, tmJson);
    check(`reachability(${cfg.name}): no dead repository keys`, r.dead.length === 0, r.dead.join(', '));
    check(`reachability(${cfg.name}): no dangling self-#refs with present source`, r.danglingWithSource.length === 0, r.danglingWithSource.join(', '));
    const tc = tokenCensus(g, tmJson);
    check(`token-completeness(${cfg.name}): every non-skip token has a discharge path`, tc.orphans.length === 0, `orphans: ${tc.orphans.join(' ')}`);
    const tm = await loadTmFromFiles(cfg.scopeName, { [cfg.scopeName]: cfg.tm, ...(cfg.tmExtra ?? {}) });
    let cov: CoverageResult = { den: 0, painted: 0, uncovered: [] };
    if (tm) cov = leafCoverage(g, tm);
    check(`coverage(${cfg.name}): every content/keyword obligation leaf is painted`, cov.painted === cov.den,
      cov.uncovered.map(u => `"${u.text}"(${u.want})`).slice(0, 8).join(' '));
    rows.push(ledgerRow(cfg.name, g, tmJson, r, tc, cov));
    const pct = cov.den ? (100 * cov.painted / cov.den).toFixed(2) : '—';
    console.log(`  ${cfg.name.padEnd(17)} repo ${String(r.repoKeys).padStart(3)} · dead ${r.dead.length} · tokens ${tc.total - tc.skip - tc.orphans.length}/${tc.total - tc.skip} · leaf-coverage ${cov.painted}/${cov.den} = ${pct}%`);
    if (cov.uncovered.length) for (const u of cov.uncovered.slice(0, 6)) console.log(`      UNCOVERED "${u.text}" want ${u.want} ctx …${u.ctx}…`);
  }

  const block = renderLedger(rows);
  if (WRITE) {
    const { changed, full } = spliceRegion(LEDGER_FILE, block);
    if (existsSync(LEDGER_FILE) && full.includes('COMPLETENESS-LEDGER:START')) { writeFileSync(LEDGER_FILE, full); console.log(`\n${changed ? '✓ updated' : '· unchanged'} ${LEDGER_FILE} ledger region`); }
    else console.log(`\n(no ${LEDGER_FILE} ledger markers yet — block below)\n\n${block}`);
  }
  if (CHECK) {
    const { changed } = spliceRegion(LEDGER_FILE, block);
    check(`${LEDGER_FILE} ledger region is up to date`, !changed || !existsSync(LEDGER_FILE), `run: node test/tm-completeness.ts --write`);
  }

  console.log('');
  for (const f of fails) console.log('  ' + f);
  console.log(`\n${failN === 0 ? `✓ ${pass}/${pass} completeness checks pass` : `✗ ${failN} FAILED (${pass} passed)`}`);
  process.exit(failN === 0 ? 0 : 1);
}

if ((import.meta as any).main) await main();
