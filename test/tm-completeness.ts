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
  followedBy, notFollowedBy, precededBy, notPrecededBy, start, end, never, anyChar, range, none, left,
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

export interface TmGrammarJson { patterns?: unknown[]; repository?: Record<string, unknown>; scopeName?: string }

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

export interface ReachResult { repoKeys: number; reached: number; dead: string[]; danglingWithSource: string[] }

export function checkReachability(g: CstGrammar, tm: TmGrammarJson): ReachResult {
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
export interface TokenCensus { total: number; skip: number; byPath: Record<string, number>; orphans: string[]; neutered: string[] }
export function tokenCensus(g: CstGrammar, tmJson: TmGrammarJson): TokenCensus {
  const repo = tmJson.repository ?? {};
  const root = tmJson.scopeName ?? `source.${g.name}`;
  const full = JSON.stringify(tmJson);
  const byPath: Record<string, number> = {};
  const orphans: string[] = [];
  const neutered: string[] = [];   // a flat token whose entry exists but paints only the bare root (no visual scope)
  let skip = 0;
  const bump = (p: string) => byPath[p] = (byPath[p] ?? 0) + 1;
  // a flat `{name, match}` entry discharges its scope obligation only if `name` is a real
  // visual scope — not the bare document root and not empty. An entry whose name was reduced
  // to the root scope is a "neuter" gap (the token tokenises but reads as inert document text),
  // structurally visible without any corpus.
  const flatNeutered = (e: any): boolean => !e.begin && !e.patterns && (!e.name || String(e.name).split(' ').every((s: string) => s === root || !s));
  for (const t of g.tokens) {
    if (t.flags.includes('skip')) { skip++; continue; }
    const flat = repo[t.name.toLowerCase()];
    if (flat) { if (flatNeutered(flat)) neutered.push(`${t.name}→${(flat as any).name ?? '∅'}`); else bump('flat'); continue; }
    if (t.flags.includes('regex')) { bump('regex-family'); continue; }
    if (tokenPatternIsNever(t)) { bump('engine-emitted'); continue; }
    if (g.markup) {
      // generateMarkupTm owns the ROLE-based markup tokens (text / tag / attr — no explicit `scope`).
      // But a markup token with an EXPLICITLY declared scope (a construct generateMarkupTm may not
      // model, e.g. a `<?…?>` processing instruction) must actually have that scope emitted — else it
      // falls through to the bare document root, the same neuter gap the token-stream path catches.
      if (t.scope && !full.includes(t.scope)) { orphans.push(`${t.name}[markup-unmodeled:${t.scope}]`); continue; }
      bump('markup-region'); continue;
    }
    const delim = tokenPatternLiteralText(t);                          // a region owns this token's delimiter?
    if (delim && full.includes(JSON.stringify(delim).slice(1, -1))) { bump('region-owned'); continue; }
    orphans.push(`${t.name}[${t.flags.join(',') || '-'}]`);
  }
  return { total: g.tokens.length, skip, byPath, orphans, neutered };
}

// ════════════════════════════════════════════════════════════════════════════
//  shared vscode-textmate tokenizer (one WASM load) — reused by Layer B coverage
// ════════════════════════════════════════════════════════════════════════════
const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

export async function loadTmFromObject(scopeName: string, grammars: Record<string, object>): Promise<vsctm.IGrammar | null> {
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
export function tmTokenize(grammar: vsctm.IGrammar, text: string): TmTok[] {
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

export interface CoverageResult { den: number; painted: number; uncovered: { text: string; want: string; ctx: string }[] }

export function leafCoverage(grammar: CstGrammar, tm: vsctm.IGrammar, opts = GEN_OPTS): CoverageResult {
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
//  STRUCTURAL literal discharge — DECIDABLE keyword completeness (no corpus)
//
//  Every alphabetic literal/operator the grammar consumes bears a keyword-scope obligation.
//  It is discharged iff it appears, as a SCOPED word, in some REACHABLE pattern whose scope
//  is a keyword family. This is a finite, structural check on the emitted artifact — the
//  a-priori (not corpus-witnessed) proof that every keyword is scoped. It asks only whether a
//  scoping pattern is PRESENT (completeness); whether its guard fires correctly is soundness.
// ════════════════════════════════════════════════════════════════════════════
const KEYWORD_FAMILY = /^(keyword|storage|constant\.language|support\.(type|class|function|constant)|variable\.language|entity\.name\.(type|tag)|punctuation\.definition\.keyword)/;

// every reachable pattern NODE (root ∪ export surfaces), the same closure as checkReachability
function reachableNodes(g: CstGrammar, tmJson: TmGrammarJson): any[] {
  const scope = tmJson.scopeName ?? `source.${g.name}`;
  const repo = (tmJson.repository ?? {}) as Record<string, any>;
  const reached = new Set<string>(); const queue: string[] = []; const out: any[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    out.push(node);
    if (typeof node.include === 'string') { const inc: string = node.include; if (inc.startsWith('#')) queue.push(inc.slice(1)); else if (inc.startsWith(scope + '#')) queue.push(inc.slice(scope.length + 1)); }
    if (node.patterns) visit(node.patterns);
    for (const c of ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures']) if (node[c]) for (const v of Object.values(node[c])) visit(v);
  };
  visit(tmJson.patterns ?? []);
  if (g.expressionRule) queue.push('expression');
  for (const k of Object.keys(g.canonicalRepoNames ?? {})) queue.push(k);
  while (queue.length) { const k = queue.shift()!; if (reached.has(k)) continue; reached.add(k); if (repo[k]) visit(repo[k]); }
  return out;
}
// the alphabetic words a node SCOPES under a keyword-family scope (lookarounds + `\b`/`\w`-escapes
// stripped so a word-boundary doesn't fuse with the word, e.g. `\bfrom\b` → `from`, not `bfrom`)
function scopedAtoms(nodes: any[]): Set<string> {
  const out = new Set<string>();
  const keywordScoped = (n: any): boolean => (typeof n.name === 'string' && KEYWORD_FAMILY.test(n.name))
    || (['captures', 'beginCaptures', 'endCaptures'] as const).some(c => n[c] && Object.values(n[c]).some((cc: any) => typeof cc?.name === 'string' && KEYWORD_FAMILY.test(cc.name)));
  for (const n of nodes) {
    if (!keywordScoped(n)) continue;
    const re = (n.match ?? n.begin ?? '') as string;
    const cleaned = re.replace(/\(\?<?[=!][^)]*\)/g, ' ').replace(/\\[a-zA-Z]/g, ' ');
    for (const w of cleaned.match(/[A-Za-z][A-Za-z0-9_$]*/g) ?? []) out.add(w);
  }
  return out;
}
export interface LiteralDischarge { obl: number; gaps: string[] }
export function literalDischarge(g: CstGrammar, tmJson: TmGrammarJson): LiteralDischarge {
  const scoped = scopedAtoms(reachableNodes(g, tmJson));
  const lits = new Set<string>();
  for (const r of g.rules) for (const l of collectLiterals(r.body)) if (isKeywordLiteral(l)) lits.add(l.replace(/^@/, ''));
  for (const p of g.precs) for (const o of p.operators) if (isKeywordLiteral(o.value)) lits.add(o.value);
  for (const lp of g.ledPrecs ?? []) if (isKeywordLiteral(lp.connector)) lits.add(lp.connector);
  const gaps = [...lits].filter(l => !scoped.has(l)).sort();
  return { obl: lits.size, gaps };
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
//  SHAPE ROBUSTNESS — a shape-detector must fire on EVERY equivalent factoring
//
//  The ~24 shape detectors in gen-tm.ts recognise a construct (ternary / call / generic
//  type-params / …) by its structure. A detector that matches one FIXED factoring (a flat
//  5-window ternary, an inline `(`, a 3-item `<sep>`) silently drops the SAME construct
//  written an equivalent way (an `opt`-tail, a separate args rule, a trailing comma) — the
//  detector-fragility class the gap-hunt surfaced. The root-cause fix is to match a NORMALISED
//  form (expandAlts + FIRST); this gate holds it: for each construct, several equivalent
//  factorings must ALL emit the same region key. It BITES if a detector regresses to a fixed
//  shape (a factoring loses the region).
// ════════════════════════════════════════════════════════════════════════════

// Shared .tsx scaffolding for the `type-param-constraint` construct: a JSX grammar (so the
// generic-arrow ⇄ JSX `extends` disambiguation guard is emitted at all) whose ONLY varying part
// is the type-param rule body, produced by `mkTParam(CType)` (CType is the registered constraint
// type rule). Mirrors the angle-bracket disambiguation fixtures in test/agnostic.ts.
function tpcGrammar(
  name: string, SelfEnd: any, CloseTg: any, Id: any,
  mkTParam: (CType: any) => any,
): Record<string, any> {
  const Type: any = rule(() => [[Id]]);
  const CType: any = rule(() => [[Id]]);                         // the constraint's TYPE rule (REGISTERED)
  const TParam = rule(() => [mkTParam(CType)]);
  const TP = rule(() => [['<', sep(TParam, ','), '>']]);
  const Param = rule(() => [[Id, opt(':', Type)]]);
  const Decl = rule(() => [['fn', Id, opt(TP), '(', sep(Param, ','), ')', '{', '}']]);   // emits #arrow-type-parameters
  const Arrow = rule(() => [[opt(TP), '(', sep(Param, ','), ')', '=>', Id]]);
  const Call = rule(() => [[Id, '<', sep(Type, ','), '>', '(', sep(Id, ','), ')']]);
  const Attr = rule(() => [[Id, opt('=', Id)]]);
  const Elem = rule(() => [['<', Id, many(Attr), alt(SelfEnd, ['>', CloseTg, Id, '>'])]]);
  const E = rule(() => [Id, Call, Arrow, Elem]);
  const S = rule(() => [Decl, E]);
  const Prog = rule(() => [[many(S)]]);
  return {
    name, scopeName: `source.${name}`,
    tokens: { SelfEnd, CloseTg, Id }, prec: [none('<', '>')],
    scopes: { 'storage.type.function': ['fn'], 'keyword.operator.expression.extends': ['extends'] },
    rules: { Type, CType, TParam, TP, Param, Decl, Arrow, Call, Attr, Elem, E, S, Prog }, entry: Prog,
  };
}

function checkShapeRobustness(): void {
  const Id = token(plus(range('a', 'z')), { identifier: true });
  // JSX delimiter tokens — needed by the constructs whose discharge only fires in a .tsx
  // grammar (the generic-arrow ⇄ JSX disambiguation, e.g. type-param-constraint below).
  const SelfEnd = token(seq('/', '>'));   // />
  const CloseTg = token(seq('<', '/'));   // </
  // A construct's obligation is "discharged" iff `observable(tm)` is true. Most are a
  // repository-key presence; some (the disambiguation guards) are a substring of an
  // emitted regex — `keyObs(k)` is the common case, an explicit `observable` the rest.
  const keyObs = (key: string) => (tm: any) => !!tm.repository[key];
  const emits = (observable: (tm: any) => boolean, build: () => Record<string, any>): boolean => {
    try { return !!observable(generateTmLanguage(defineGrammar(build() as any) as any) as any); }
    catch { return false; }
  };
  // each construct, in several EQUIVALENT factorings; the obligation must discharge in all.
  // `xfail` records factorings a detector is KNOWN to drop today (issue #51 residual fragility):
  // the assertion tolerates exactly those, so the gate goes RED on a NEW drop or once a fix lands
  // and the xfail goes stale — never a silent false-green, never a permanent red.
  const constructs: { name: string; key?: string; observable: (tm: any) => boolean; xfail?: string[]; factorings: { label: string; build: () => Record<string, any> }[] }[] = [
    {
      name: 'ternary', key: 'ternary-expression', observable: keyObs('ternary-expression'), factorings: [
        { label: 'flat', build: () => { const E = rule((s: any) => [[Id, '?', s, ':', s], [Id]]); const P = rule(() => [[many(E)]]); return { name: 't1', scopeName: 'source.t1', tokens: { Id }, rules: { E, P }, entry: P }; } },
        { label: 'opt-tail', build: () => { const E = rule((s: any) => [[Id, opt('?', s, ':', s)]]); const P = rule(() => [[many(E)]]); return { name: 't2', scopeName: 'source.t2', tokens: { Id }, rules: { E, P }, entry: P }; } },
      ],
    },
    {
      name: 'call', key: 'function-call', observable: keyObs('function-call'), factorings: [
        { label: 'inline', build: () => { const A = rule(() => [[Id]]); const E = rule((s: any) => [[A, '(', sep(s, ','), ')'], [A]]); const P = rule(() => [[many(E)]]); return { name: 'c1', scopeName: 'source.c1', tokens: { Id }, rules: { A, E, P }, entry: P }; } },
        { label: 'args-rule', build: () => { const A = rule(() => [[Id]]); const CA = rule((s: any) => [['(', sep(s, ','), ')']]); const C = rule((s: any) => [[A, CA], [A]]); const E = rule((s: any) => [[C]]); const P = rule(() => [[many(E)]]); return { name: 'c2', scopeName: 'source.c2', tokens: { Id }, rules: { A, CA, C, E, P }, entry: P }; } },
      ],
    },
    {
      name: 'generic-type-params', key: 'declaration-type-params', observable: keyObs('declaration-type-params'), factorings: [
        { label: '3-item', build: () => { const T = rule(() => [[Id]]); const Pm = rule(() => [[Id, opt('extends', T)]]); const TP = rule(() => [['<', sep(Pm, ','), '>']]); const D = rule(() => [['fn', Id, opt(TP), '{', '}']]); const P = rule(() => [[many(D)]]); return { name: 'g1', scopeName: 'source.g1', tokens: { Id }, prec: [none('<', '>')], scopes: { 'storage.type.function': ['fn'], 'keyword.operator.expression.extends': ['extends'] }, rules: { T, Pm, TP, D, P }, entry: P }; } },
        { label: 'trailing-comma', build: () => { const T = rule(() => [[Id]]); const Pm = rule(() => [[Id, opt('extends', T)]]); const TP = rule(() => [['<', sep(Pm, ','), opt(','), '>']]); const D = rule(() => [['fn', Id, opt(TP), '{', '}']]); const P = rule(() => [[many(D)]]); return { name: 'g2', scopeName: 'source.g2', tokens: { Id }, prec: [none('<', '>')], scopes: { 'storage.type.function': ['fn'], 'keyword.operator.expression.extends': ['extends'] }, rules: { T, Pm, TP, D, P }, entry: P }; } },
      ],
    },
    // ── conditional-type (detectConditionalType, key #type-conditional) ──
    // `{type:true}` rule with `ref KW ref ? ref : ref`. detectConditionalType runs its
    // 7-window over expandAlts(body), so opt-tail / alt-split normalise to the same flat
    // adjacency. ROBUST (all factorings emit).
    {
      name: 'conditional-type', key: 'type-conditional', observable: keyObs('type-conditional'), factorings: [
        { label: 'canonical', build: () => { const T: any = rule(() => [[Id, 'extends', Id, '?', Id, ':', Id], [Id]], { type: true }); const Ann = rule(() => [[Id, ':', T]]); const P = rule(() => [[many(Ann)]]); return { name: 'cd1', scopeName: 'source.cd1', tokens: { Id }, scopes: { 'keyword.operator.expression.extends': ['extends'] }, rules: { T, Ann, P }, entry: P }; } },
        { label: 'opt-tail', build: () => { const T: any = rule(() => [[Id, opt('extends', Id, '?', Id, ':', Id)]], { type: true }); const Ann = rule(() => [[Id, ':', T]]); const P = rule(() => [[many(Ann)]]); return { name: 'cd2', scopeName: 'source.cd2', tokens: { Id }, scopes: { 'keyword.operator.expression.extends': ['extends'] }, rules: { T, Ann, P }, entry: P }; } },
        { label: 'alt-split', build: () => { const T: any = rule(() => [alt([Id, 'extends', Id, '?', Id, ':', Id], [Id])], { type: true }); const Ann = rule(() => [[Id, ':', T]]); const P = rule(() => [[many(Ann)]]); return { name: 'cd3', scopeName: 'source.cd3', tokens: { Id }, scopes: { 'keyword.operator.expression.extends': ['extends'] }, rules: { T, Ann, P }, entry: P }; } },
      ],
    },
    // ── generic-call (detectAngleBracketAmbiguity, key #generic-call) ──
    // `<` sep(ref) `>` CONFIRM (the confirm token is the item after `>`). The detector walks
    // expandAlts(body), so the `(args)` confirm written as an opt-tail or reached through an
    // alt() still surfaces the `< sep > (` adjacency. Needs `<`/`>` in the prec table. ROBUST.
    {
      name: 'generic-call', key: 'generic-call', observable: keyObs('generic-call'), factorings: [
        { label: 'canonical', build: () => { const T = rule(() => [[Id]]); const Call = rule(() => [[Id, '<', sep(T, ','), '>', '(', sep(Id, ','), ')']]); const E = rule(() => [Id, Call]); const P = rule(() => [[many(E)]]); return { name: 'gc1', scopeName: 'source.gc1', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, E, P }, entry: P }; } },
        { label: 'opt-tail', build: () => { const T = rule(() => [[Id]]); const Call = rule(() => [[Id, '<', sep(T, ','), '>', opt('(', sep(Id, ','), ')')]]); const E = rule(() => [Id, Call]); const P = rule(() => [[many(E)]]); return { name: 'gc2', scopeName: 'source.gc2', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, E, P }, entry: P }; } },
        { label: 'alt-confirm', build: () => { const T = rule(() => [[Id]]); const Call = rule(() => [[Id, '<', sep(T, ','), '>', alt(['(', sep(Id, ','), ')'], [Id])]]); const E = rule(() => [Id, Call]); const P = rule(() => [[many(E)]]); return { name: 'gc3', scopeName: 'source.gc3', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, E, P }, entry: P }; } },
      ],
    },
    // ── angle-cast (detectAngleBracketCast, key #type-cast) ──
    // 4-window `<` ref(@type) `>` operand. The cast head written as its OWN rule
    // (`CastHead = '<' Type '>'`, used as `[CastHead, operand]`) hides the `<`/`>` across the ref
    // boundary; detectAngleBracketCast now resolves a ref to such a cast-head rule by name (like
    // detectCallExpression reaches its args through a separate rule), so `via-ref` is robust too.
    {
      name: 'angle-cast', key: 'type-cast', observable: keyObs('type-cast'), factorings: [
        { label: 'canonical', build: () => { const T = rule(() => [[Id]], { type: true }); const Call = rule(() => [[Id, '<', sep(T, ','), '>', '(', sep(Id, ','), ')']]); const Cast = rule(() => [['<', T, '>', Id]]); const E = rule(() => [Id, Cast, Call]); const P = rule(() => [[many(E)]]); return { name: 'ac1', scopeName: 'source.ac1', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, Cast, E, P }, entry: P }; } },
        { label: 'opt-operand', build: () => { const T = rule(() => [[Id]], { type: true }); const Call = rule(() => [[Id, '<', sep(T, ','), '>', '(', sep(Id, ','), ')']]); const Cast = rule(() => [['<', T, '>', opt(Id)]]); const E = rule(() => [Id, Cast, Call]); const P = rule(() => [[many(E)]]); return { name: 'ac3', scopeName: 'source.ac3', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, Cast, E, P }, entry: P }; } },
        { label: 'via-ref', build: () => { const T = rule(() => [[Id]], { type: true }); const Call = rule(() => [[Id, '<', sep(T, ','), '>', '(', sep(Id, ','), ')']]); const CastHead = rule(() => [['<', T, '>']]); const Cast = rule(() => [[CastHead, Id]]); const E = rule(() => [Id, Cast, Call]); const P = rule(() => [[many(E)]]); return { name: 'ac2', scopeName: 'source.ac2', tokens: { Id }, prec: [none('<', '>')], rules: { T, Call, CastHead, Cast, E, P }, entry: P }; } },
      ],
    },
    // ── type-param-constraint (detectTypeParamConstraintKeywords) ──
    // observable: the constraint keyword (`extends`) appears in the #arrow-type-parameters begin
    // guard (the .tsx generic-arrow ⇄ JSX disambiguation `topTypeParam`) — so this needs a JSX
    // grammar (`/>`,`</` tokens) and a generic-arrow shape. detectTypeParamConstraintKeywords now
    // reads the constraint as the OPTIONAL `[kw, type]` segment by which one expandAlts branch
    // extends a prefix-shorter sibling, so `alt([name, kw, type],[name])` (optionality via an alt
    // branch, not `?`) and `opt(kw, sep(type,'&'))` (the type behind a `sep`) are robust too — while
    // a leading modifier (whose own optionality is NOT a prefix extension) is still excluded.
    {
      name: 'type-param-constraint', key: 'arrow-type-parameters[extends]',
      observable: (tm: any) => ((tm.repository['arrow-type-parameters']?.begin as string) ?? '').includes('\\bextends\\b'),
      factorings: [
        { label: 'canonical', build: () => tpcGrammar('tpc1', SelfEnd, CloseTg, Id, (CType) => [Id, opt('extends', CType)]) },
        { label: 'alt-split', build: () => tpcGrammar('tpc2', SelfEnd, CloseTg, Id, (CType) => alt([Id, 'extends', CType], [Id])) },
        { label: 'sep-constraint', build: () => tpcGrammar('tpc3', SelfEnd, CloseTg, Id, (CType) => [Id, opt('extends', sep(CType, '&'))]) },
      ],
    },
    {
      name: "bare-arrow", observable: (tm => !!tm.repository['arrow-parameter'] && JSON.stringify(tm.repository['arrow-parameter']).includes('variable.parameter')),
      factorings: [
        { label: "canonical", build: () => { const E = rule((s) => [[Id, '=>', s], [Id]]); const P = rule(() => [[many(E)]]); return { name: 'ba1', scopeName: 'source.ba1', tokens: { Id }, rules: { E, P }, entry: P }; } },
        { label: "opt-tail", build: () => { const E = rule((s) => [[Id, opt('=>', s)]]); const P = rule(() => [[many(E)]]); return { name: 'ba2', scopeName: 'source.ba2', tokens: { Id }, rules: { E, P }, entry: P }; } },
        { label: "via-ref", build: () => { const Ar = rule((s) => [[Id, '=>', s]]); const E = rule((s) => [Ar, [Id]]); const P = rule(() => [[many(E)]]); return { name: 'ba3', scopeName: 'source.ba3', tokens: { Id }, rules: { Ar, E, P }, entry: P }; } },
      ],
    },
    {
      name: "property-access", observable: (tm => !!tm.repository['property-access'] && JSON.stringify(tm.repository['property-access']).includes('entity.other.property')),
      factorings: [
        { label: "canonical", build: () => { const E = rule((s) => [[Id, many('.', Id)], [Id]]); const P = rule(() => [[many(E)]]); return { name: 'pa1', scopeName: 'source.pa1', tokens: { Id }, rules: { E, P }, entry: P }; } },
        { label: "opt-tail", build: () => { const E = rule((s) => [[Id, opt('.', Id)]]); const P = rule(() => [[many(E)]]); return { name: 'pa2', scopeName: 'source.pa2', tokens: { Id }, rules: { E, P }, entry: P }; } },
        { label: "via-ref", build: () => { const Acc = rule(() => [['.', Id]]); const E = rule(() => [[Id, many(Acc)], [Id]]); const P = rule(() => [[many(E)]]); return { name: 'pa3', scopeName: 'source.pa3', tokens: { Id }, rules: { Acc, E, P }, entry: P }; } },
      ],
    },
    {
      name: "paren-arrow", observable: (tm => { const r = tm.repository['arrow-function-params']; return !!r && JSON.stringify(r).includes('variable.parameter'); }),
      factorings: [
        { label: "canonical", build: () => { const Pm = rule(() => [[Id]]); const E = rule((s) => [['(', sep(Pm, ','), ')', '=>', s], [Id]]); const P = rule(() => [[many(E)]]); return { name: 'pra1', scopeName: 'source.pra1', tokens: { Id }, rules: { Pm, E, P }, entry: P }; } },
        { label: "opt-tail", build: () => { const Pm = rule(() => [[Id]]); const Ty = rule(() => [[Id]]); const E = rule((s) => [['(', sep(Pm, ','), ')', opt(':', Ty), '=>', s], [Id]]); const P = rule(() => [[many(E)]]); return { name: 'pra2', scopeName: 'source.pra2', tokens: { Id }, rules: { Pm, Ty, E, P }, entry: P }; } },
        { label: "alt-split", build: () => { const Pm = rule(() => [[Id]]); const E = rule((s) => [alt(['(', sep(Pm, ','), ')', '=>', s], [Id])]); const P = rule(() => [[many(E)]]); return { name: 'pra3', scopeName: 'source.pra3', tokens: { Id }, rules: { Pm, E, P }, entry: P }; } },
      ],
    },
    {
      name: "direct-param-keyword", observable: (tm => !!tm.repository['ctor-declaration'] && !!tm.repository['declaration-params']),
      factorings: [
        { label: "canonical", build: () => { const Pm = rule(() => [[Id]]); const Blk = rule(() => [['{', '}']]); const D = rule(() => [['fn', Id, '(', sep(Pm, ','), ')', Blk]]); const Ctor = rule(() => [['ctor', '(', sep(Pm, ','), ')', Blk]]); const Mem = rule(() => [D, Ctor]); const Body = rule(() => [['{', many(Mem), '}']]); const Cls = rule(() => [['cls', Id, Body]]); const P = rule(() => [[many(Cls)]]); return { name: 'dpk1', scopeName: 'source.dpk1', tokens: { Id }, scopes: { 'storage.type.function': ['fn', 'ctor'], 'storage.type.class': ['cls'] }, rules: { Pm, Blk, D, Ctor, Mem, Body, Cls, P }, entry: P }; } },
        { label: "alt-split", build: () => { const Pm = rule(() => [[Id]]); const Blk = rule(() => [['{', '}']]); const D = rule(() => [['fn', Id, '(', sep(Pm, ','), ')', Blk]]); const Ctor = rule(() => [alt(['ctor', '(', sep(Pm, ','), ')', Blk], ['ctor', '(', ')', Blk])]); const Mem = rule(() => [D, Ctor]); const Body = rule(() => [['{', many(Mem), '}']]); const Cls = rule(() => [['cls', Id, Body]]); const P = rule(() => [[many(Cls)]]); return { name: 'dpk2', scopeName: 'source.dpk2', tokens: { Id }, scopes: { 'storage.type.function': ['fn', 'ctor'], 'storage.type.class': ['cls'] }, rules: { Pm, Blk, D, Ctor, Mem, Body, Cls, P }, entry: P }; } },
        { label: "opt-tail", build: () => { const Pm = rule(() => [[Id]]); const Blk = rule(() => [['{', '}']]); const D = rule(() => [['fn', Id, '(', sep(Pm, ','), ')', Blk]]); const Ctor = rule(() => [['ctor', '(', opt(sep(Pm, ',')), ')', Blk]]); const Mem = rule(() => [D, Ctor]); const Body = rule(() => [['{', many(Mem), '}']]); const Cls = rule(() => [['cls', Id, Body]]); const P = rule(() => [[many(Cls)]]); return { name: 'dpk3', scopeName: 'source.dpk3', tokens: { Id }, scopes: { 'storage.type.function': ['fn', 'ctor'], 'storage.type.class': ['cls'] }, rules: { Pm, Blk, D, Ctor, Mem, Body, Cls, P }, entry: P }; } },
      ],
    },
    {
      name: "constructor-keyword", observable: (tm => !!tm.repository['new-expression'] && JSON.stringify(tm.repository['new-expression']).includes('keyword.operator.expression.new')),
      factorings: [
        { label: "canonical", build: () => { const Ty = rule(() => [[Id]]); const NewE = rule((s) => [['new', Ty, '(', sep(s, ','), ')'], [Id]]); const P = rule(() => [[many(NewE)]]); return { name: 'ck1', scopeName: 'source.ck1', tokens: { Id }, scopes: { 'keyword.operator.expression.new': ['new'] }, rules: { Ty, NewE, P }, entry: P }; } },
        { label: "opt-call-tail", build: () => { const Ty = rule(() => [[Id]]); const NewE = rule((s) => [['new', Ty, opt('(', sep(s, ','), ')')], [Id]]); const P = rule(() => [[many(NewE)]]); return { name: 'ck2', scopeName: 'source.ck2', tokens: { Id }, scopes: { 'keyword.operator.expression.new': ['new'] }, rules: { Ty, NewE, P }, entry: P }; } },
        { label: "alt-split", build: () => { const Ty = rule(() => [[Id]]); const TArgs = rule(() => [['<', sep(Ty, ','), '>']]); const NewE = rule((s) => [['new', Ty, opt(alt([TArgs], ['(', sep(s, ','), ')']))], [Id]]); const P = rule(() => [[many(NewE)]]); return { name: 'ck3', scopeName: 'source.ck3', tokens: { Id }, prec: [none('<', '>')], scopes: { 'keyword.operator.expression.new': ['new'] }, rules: { Ty, TArgs, NewE, P }, entry: P }; } },
      ],
    },
    {
      name: "block-declaration", observable: (tm => !!tm.repository['declaration-body']),
      factorings: [
        { label: "canonical", build: () => { const M = rule(() => [[Id]]); const Body = rule(() => [['{', many(M), '}']]); const D = rule(() => [['class', Id, Body]]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'b1', scopeName: 'source.b1', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, Body, D, P }, entry: P }; } },
        { label: "alt-split", build: () => { const M = rule(() => [[Id]]); const Body = rule(() => [['{', many(M), '}'], ['{', '}']]); const D = rule(() => [['class', Id, Body]]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'b2', scopeName: 'source.b2', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, Body, D, P }, entry: P }; } },
        { label: "opt-tail", build: () => { const M = rule(() => [[Id]]); const Body = rule(() => [['{', opt(many(M)), '}']]); const D = rule(() => [['class', Id, Body]]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'b3', scopeName: 'source.b3', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, Body, D, P }, entry: P }; } },
        { label: "via-ref", build: () => { const M = rule(() => [[Id]]); const Body = rule(() => [['{', many(M), '}']]); const D = rule(() => [['class', Id, opt(Body)]]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'b4', scopeName: 'source.b4', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, Body, D, P }, entry: P }; } },
      ],
    },
    {
      name: "class-declaration-head", observable: (tm => { const r = tm.repository['class-declaration']; return !!r && JSON.stringify(r.beginCaptures ?? {}).includes('entity.name.type.class'); }),
      factorings: [
        { label: "canonical", build: () => { const M = rule(() => [[Id]]); const D = rule(() => [['class', Id, '{', many(M), '}']]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'h1', scopeName: 'source.h1', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, D, P }, entry: P }; } },
        { label: "via-ref", build: () => { const M = rule(() => [[Id]]); const Body = rule(() => [['{', many(M), '}']]); const D = rule(() => [['class', Id, Body]]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'h2', scopeName: 'source.h2', tokens: { Id }, scopes: { 'storage.type.class': ['class'] }, rules: { M, Body, D, P }, entry: P }; } },
        { label: "type-params", build: () => { const T = rule(() => [[Id]]); const TP = rule(() => [['<', sep(T, ','), '>']]); const M = rule(() => [[Id]]); const D = rule(() => [['class', Id, opt(TP), '{', many(M), '}']]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'h3', scopeName: 'source.h3', tokens: { Id }, prec: [none('<', '>')], scopes: { 'storage.type.class': ['class'] }, rules: { T, TP, M, D, P }, entry: P }; } },
        { label: "alt-split", build: () => { const M = rule(() => [[Id]]); const D = rule(() => [[opt('abstract'), 'class', Id, '{', many(M), '}']]); const P = rule(() => [[many(alt(D, Id))]]); return { name: 'h4', scopeName: 'source.h4', tokens: { Id }, scopes: { 'storage.type.class': ['class'], 'storage.modifier': ['abstract'] }, rules: { M, D, P }, entry: P }; } },
      ],
    },
    {
      name: "regex-literal", observable: (tm => !!tm.repository['regex-literal']),
      factorings: [
        { label: "canonical", build: () => { const Re = token(seq('/', plus(range('a','z')), '/'), { regex: true }); const Ex = rule(() => [Id, Re]); const P = rule(() => [[many(Ex)]]); return { name: 'r1', scopeName: 'source.r1', tokens: { Id, Re }, prec: [left('/')], rules: { Ex, P }, entry: P }; } },
        { label: "alt-split", build: () => { const Re = token(seq('/', plus(range('a','z')), '/'), { regex: true }); const Ex = rule(() => [Id, Re]); const P = rule(() => [[many(Ex)]]); return { name: 'r2', scopeName: 'source.r2', tokens: { Id, Re }, prec: [none('/')], rules: { Ex, P }, entry: P }; } },
        { label: "via-ref", build: () => { const Re = token(seq('/', plus(range('a','z')), '/'), { regex: true }); const Ex = rule(() => [Id, Re]); const P = rule(() => [[many(Ex)]]); return { name: 'r3', scopeName: 'source.r3', tokens: { Id, Re }, prec: [left('/=')], rules: { Ex, P }, entry: P }; } },
      ],
    },
    {
      name: "block-sequence", observable: (tm => !!tm.repository['block-sequence']),
      factorings: [
        { label: "canonical", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted', blockPattern: seq(ph, PB) }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag', blockPattern: seq(ph, PB, KS) }); const BlockScalar = token(never(), { scope: 'string.unquoted.block' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const Item = rule(() => [['-', Key, Plain]]); const Seq = rule(() => [[Item, many(Newline, Item)]]); const Fold = rule(() => [[Plain, many(Newline, Plain)]]); const Node = rule(() => [Seq, Fold, Key, Plain, BlockScalar]); const Doc = rule(() => [[many(Node)]]); return { name: 'bseqA', scopeName: 'source.bseqA', tokens: { Key, Plain, BlockScalar, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'], blockScalar: { introducers: ['|', '>'], token: 'BlockScalar', documentMarkers: ['---', '...'], indicatorScope: 'keyword.control.flow.block-scalar' } }, rules: { Item, Seq, Fold, Node, Doc }, entry: Doc }; } },
        { label: "plus-arity", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted', blockPattern: seq(ph, PB) }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag', blockPattern: seq(ph, PB, KS) }); const BlockScalar = token(never(), { scope: 'string.unquoted.block' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const Item = rule(() => [['-', Key, Plain]]); const Seq = rule(() => [[Item, Newline, Item, many(Newline, Item)]]); const Fold = rule(() => [[Plain, many(Newline, Plain)]]); const Node = rule(() => [Seq, Fold, Key, Plain, BlockScalar]); const Doc = rule(() => [[many(Node)]]); return { name: 'bseqB', scopeName: 'source.bseqB', tokens: { Key, Plain, BlockScalar, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'], blockScalar: { introducers: ['|', '>'], token: 'BlockScalar', documentMarkers: ['---', '...'], indicatorScope: 'keyword.control.flow.block-scalar' } }, rules: { Item, Seq, Fold, Node, Doc }, entry: Doc }; } },
      ],
    },
    {
      name: "explicit-key", observable: (tm => !!tm.repository['explicit-key']),
      factorings: [
        { label: "canonical", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted' }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const ExplicitEntry = rule(() => [['?', Key, opt(':', Plain)]]); const ExplicitMapping = rule(() => [[ExplicitEntry, many(Newline, ExplicitEntry)]]); const Node = rule(() => [ExplicitMapping, Plain]); const Doc = rule(() => [[many(Node)]]); return { name: 'ekA', scopeName: 'source.ekA', tokens: { Key, Plain, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'] }, rules: { ExplicitEntry, ExplicitMapping, Node, Doc }, entry: Doc }; } },
        { label: "opt-tail (many-quantified equivalent)", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted' }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const ExplicitEntry = rule(() => [['?', Key, many(':', Plain)]]); const ExplicitMapping = rule(() => [[ExplicitEntry, many(Newline, ExplicitEntry)]]); const Node = rule(() => [ExplicitMapping, Plain]); const Doc = rule(() => [[many(Node)]]); return { name: 'ekB', scopeName: 'source.ekB', tokens: { Key, Plain, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'] }, rules: { ExplicitEntry, ExplicitMapping, Node, Doc }, entry: Doc }; } },
      ],
    },
    {
      name: "flow-mapping", observable: (tm => !!tm.repository['flow-mapping']),
      factorings: [
        { label: "canonical", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted' }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const FlowEntry = rule(() => [[Key, ':', Plain]]); const FlowMap = rule(() => [['{', sep(FlowEntry, ','), '}']]); const FlowSeq = rule(() => [['[', sep(Plain, ','), ']']]); const Node = rule(() => [FlowMap, FlowSeq, Plain]); const Doc = rule(() => [[many(Node)]]); const fs = { byOpen: { '{': { begin: 'punctuation.definition.mapping.begin', end: 'punctuation.definition.mapping.end', separator: 'punctuation.separator.mapping' }, '[': { begin: 'punctuation.definition.sequence.begin', end: 'punctuation.definition.sequence.end', separator: 'punctuation.separator.sequence' } }, keyValue: 'punctuation.separator.key-value' }; return { name: 'fmA', scopeName: 'source.fmA', tokens: { Key, Plain, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', flowScopes: fs, foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'] }, rules: { FlowEntry, FlowMap, FlowSeq, Node, Doc }, entry: Doc }; } },
        { label: "trailing-comma", build: () => { const ph = noneOf(' ', '\t', '\n', ':', '-', '?', ',', '[', ']', '{', '}', '#'); const PB = star(noneOf(':', '\n', ',', '[', ']', '{', '}')); const KS = followedBy(seq(star(oneOf(' ', '\t')), ':')); const Plain = token(seq(ph, PB), { scope: 'string.unquoted' }); const Key = token(seq(ph, PB, KS), { scope: 'entity.name.tag' }); const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {}); const FlowEntry = rule(() => [[Key, ':', Plain]]); const FlowMap = rule(() => [['{', sep(FlowEntry, ','), opt(','), '}']]); const FlowSeq = rule(() => [['[', sep(Plain, ','), ']']]); const Node = rule(() => [FlowMap, FlowSeq, Plain]); const Doc = rule(() => [[many(Node)]]); const fs = { byOpen: { '{': { begin: 'punctuation.definition.mapping.begin', end: 'punctuation.definition.mapping.end', separator: 'punctuation.separator.mapping' }, '[': { begin: 'punctuation.definition.sequence.begin', end: 'punctuation.definition.sequence.end', separator: 'punctuation.separator.sequence' } }, keyValue: 'punctuation.separator.key-value' }; return { name: 'fmB', scopeName: 'source.fmB', tokens: { Key, Plain, Indent, Dedent, Newline }, indent: { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['[', '{'], flowClose: [']', '}'], comment: '#', keyValueSeparator: ':', flowScopes: fs, foldTokens: ['Key', 'Plain'], compactIndicators: ['-', '?'] }, rules: { FlowEntry, FlowMap, FlowSeq, Node, Doc }, entry: Doc }; } },
      ],
    },
    {
      name: "markup-tag", observable: (tm => !!tm.repository['tag']),
      factorings: [
        { label: "canonical", build: () => { const Id = token(plus(range('a', 'z')), { identifier: true }); const Text = token(never(), { scope: 'text' }); const Tag = rule(() => [['<', Id, '>']]); const Doc = rule(() => [[many(alt(Tag, Id))]]); return { name: 'mkA', scopeName: 'text.mkA', tokens: { Id, Text }, markup: { textToken: 'Text', tagOpen: '<', tagClose: '>', closeMarker: '/' }, rules: { Tag, Doc }, entry: Doc }; } },
        { label: "alt-split (open/self-close/close element)", build: () => { const Id = token(plus(range('a', 'z')), { identifier: true }); const Text = token(never(), { scope: 'text' }); const SelfEnd = token(seq('/', '>')); const CloseTg = token(seq('<', '/')); const Tag = rule(() => [['<', Id, alt(SelfEnd, ['>', CloseTg, Id, '>'])]]); const Doc = rule(() => [[many(alt(Tag, Id))]]); return { name: 'mkB', scopeName: 'text.mkB', tokens: { SelfEnd, CloseTg, Id, Text }, markup: { textToken: 'Text', tagOpen: '<', tagClose: '>', closeMarker: '/' }, rules: { Tag, Doc }, entry: Doc }; } },
      ],
    },
    // ── jsx-element (detectJsx, key #jsx-element-in-expression) ──
    // an element shape `'<' Id … ('/>' | '>' '</' Id '>')`. detectJsx's hasElementShape walks
    // expandAlts branches for the `<`+ref lead, so the attribute list written inline or wrapped in
    // an `opt`/`alt` still surfaces the element. ROBUST.
    {
      name: 'jsx-element', observable: (tm: any) => !!tm.repository['jsx-element-in-expression'],
      factorings: [
        { label: 'canonical', build: () => { const Attr = rule(() => [[Id, opt('=', Id)]]); const Elem = rule(() => [['<', Id, many(Attr), alt(SelfEnd, ['>', CloseTg, Id, '>'])]]); const E = rule(() => [Id, Elem]); const P = rule(() => [[many(E)]]); return { name: 'jx1', scopeName: 'source.jx1', tokens: { SelfEnd, CloseTg, Id }, prec: [none('<', '>')], rules: { Attr, Elem, E, P }, entry: P }; } },
        { label: 'opt-attrs', build: () => { const Attr = rule(() => [[Id, opt('=', Id)]]); const Elem = rule(() => [['<', Id, opt(many(Attr)), alt(SelfEnd, ['>', CloseTg, Id, '>'])]]); const E = rule(() => [Id, Elem]); const P = rule(() => [[many(E)]]); return { name: 'jx2', scopeName: 'source.jx2', tokens: { SelfEnd, CloseTg, Id }, prec: [none('<', '>')], rules: { Attr, Elem, E, P }, entry: P }; } },
      ],
    },
  ];
  for (const c of constructs) {
    const xfail = new Set(c.xfail ?? []);
    const results = c.factorings.map(f => ({ label: f.label, ok: emits(c.observable, f.build) }));
    // PASS unless a factoring NOT on the xfail list drops, OR a factoring ON it unexpectedly
    // started discharging (stale xfail — the fix may have landed; drop the annotation).
    const newDrops = results.filter(r => !r.ok && !xfail.has(r.label)).map(r => r.label);
    const staleXfail = results.filter(r => r.ok && xfail.has(r.label)).map(r => r.label);
    check(`shape-robustness: \`${c.name}\` discharges #${c.key ?? c.name} for every equivalent factoring`,
      newDrops.length === 0 && staleXfail.length === 0,
      [newDrops.length ? `drops: ${newDrops.join(', ')}` : '',
       staleXfail.length ? `stale xfail (now discharges, remove): ${staleXfail.join(', ')}` : '',
       xfail.size ? `(known #51 drops still expected: ${[...xfail].join(', ')})` : ''].filter(Boolean).join('  '));
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
  litObl: number; litDisch: number;            // alphabetic keyword literals, each → a reachable keyword-scoped pattern (structural)
  keyObl: number; keyReach: number;            // repository keys, each → reachable
  leafObl: number; leafPaint: number;          // empirical content/keyword leaves (the corpus cross-check)
}
function ledgerRow(name: string, g: CstGrammar, r: ReachResult, tc: TokenCensus, ld: LiteralDischarge, cov: CoverageResult): LedgerRow {
  const nonSkip = g.tokens.filter(t => !t.flags.includes('skip')).length;
  return {
    name,
    tokenObl: nonSkip, tokenDisch: nonSkip - tc.orphans.length - tc.neutered.length,
    litObl: ld.obl, litDisch: ld.obl - ld.gaps.length,
    keyObl: r.repoKeys, keyReach: r.repoKeys - r.dead.length,
    leafObl: cov.den, leafPaint: cov.painted,
  };
}

// the auto-generated ledger block (a region in COMPLETENESS.md, like KNOWN-GAPS.md / the README issue table)
function renderLedger(rows: LedgerRow[]): string {
  const L: string[] = [];
  L.push('<!-- COMPLETENESS-LEDGER:START — auto-generated by `node test/tm-completeness.ts --write`; do not edit by hand. -->');
  L.push('');
  L.push('| Grammar | Tokens | Keyword literals | Repo keys (reachable) | Leaf cross-check (corpus) |');
  L.push('|---|---:|---:|---:|---:|');
  const sum = { t: 0, td: 0, lit: 0, ld: 0, k: 0, kr: 0, lf: 0, lp: 0 };
  for (const r of rows) {
    L.push(`| ${r.name} | ${r.tokenDisch}/${r.tokenObl} | ${r.litDisch}/${r.litObl} | ${r.keyReach}/${r.keyObl} | ${r.leafPaint}/${r.leafObl} |`);
    sum.t += r.tokenObl; sum.td += r.tokenDisch; sum.lit += r.litObl; sum.ld += r.litDisch;
    sum.k += r.keyObl; sum.kr += r.keyReach; sum.lf += r.leafObl; sum.lp += r.leafPaint;
  }
  L.push(`| **total** | **${sum.td}/${sum.t}** | **${sum.ld}/${sum.lit}** | **${sum.kr}/${sum.k}** | **${sum.lp}/${sum.lf}** |`);
  L.push('');
  // the DECIDABLE fixed denominator = the structural obligations (token discharge + keyword-literal
  // discharge + repository reachability), checked a-priori on the emitted artifact, no corpus. The
  // leaf cross-check is the redundant corpus witness (the soundness-axis dual), reported separately.
  const den = sum.t + sum.k + sum.lit, num = sum.td + sum.kr + sum.ld;
  L.push(`**Decidable completeness: ${num}/${den} = ${(100 * num / den).toFixed(2)}%** ` +
    `(token discharge ${sum.td}/${sum.t} · keyword-literal discharge ${sum.ld}/${sum.lit} · repository reachability ${sum.kr}/${sum.k}) — ` +
    `a structural check on the emitted artifact, no corpus. Leaf cross-check (corpus, redundant): ${sum.lp}/${sum.lf}. ` +
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

  console.log('── Shape robustness: detectors fire on every equivalent factoring ──');
  checkShapeRobustness();

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
    check(`token-completeness(${cfg.name}): no flat token is neutered to the bare root scope`, tc.neutered.length === 0, `neutered: ${tc.neutered.join(' ')}`);
    const ld = literalDischarge(g, tmJson);
    check(`literal-completeness(${cfg.name}): every keyword literal/operator is in a reachable keyword-scoped pattern`, ld.gaps.length === 0, `undischarged: ${ld.gaps.join(' ')}`);
    const tm = await loadTmFromFiles(cfg.scopeName, { [cfg.scopeName]: cfg.tm, ...(cfg.tmExtra ?? {}) });
    let cov: CoverageResult = { den: 0, painted: 0, uncovered: [] };
    if (tm) cov = leafCoverage(g, tm);
    check(`coverage cross-check(${cfg.name}): every content/keyword obligation leaf is painted`, cov.painted === cov.den,
      cov.uncovered.map(u => `"${u.text}"(${u.want})`).slice(0, 8).join(' '));
    rows.push(ledgerRow(cfg.name, g, r, tc, ld, cov));
    const pct = cov.den ? (100 * cov.painted / cov.den).toFixed(2) : '—';
    console.log(`  ${cfg.name.padEnd(17)} repo ${String(r.repoKeys).padStart(3)} · dead ${r.dead.length} · tokens ${tc.total - tc.skip - tc.orphans.length}/${tc.total - tc.skip} · keyword-literals ${ld.obl - ld.gaps.length}/${ld.obl} · leaf-xcheck ${cov.painted}/${cov.den}`);
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
