// ── emit-parser ──
//
// An EMITTER (vs the createParser RUNTIME INTERPRETER in gen-parser.ts). It takes
// the same CstGrammar, re-derives the SAME static analysis createParser does
// (precedence/binding-power tables, Pratt NUD/LED classification, FIRST sets,
// nullability, mixfix/access-tail detection), and emits SELF-CONTAINED JavaScript
// for a parser that bakes those tables in as constants and emits the PER-RULE +
// PER-ARM matching as SPECIALIZED straight-line code — replacing the interpreter's
// matchExpr/matchSeq/matchQuantifier/matchSep tree-walk dispatch.
//
// The algorithmic CONTROL cores (the Pratt precedence loop, the left-recursion
// loop, the longest-match non-recursive loop, the mixfix operand re-bind, the
// packrat memo, save/restore backtracking) stay as a generic runtime that the
// emitted code CALLS — copied VERBATIM from gen-parser.ts so their longest-match /
// tail-closing / suppress / mixfix semantics are byte-identical to the oracle.
// What those loops used to dispatch per arm (matchExpr(alt) / matchSeq(items)) is
// now a GENERATED specialized matcher per NUD/LED/alt arm, so the interpretive
// dispatch — the ~third of parse time the CPU profile attributes to matchExpr +
// per-arm re-classification — is removed.
//
// The LEXER is identical in both worlds and is OUTSIDE this optimization, so the
// emitted code imports the fixed createLexer RUNTIME and feeds it the grammar's
// baked token+config DATA (a "grammar-lite"); it never imports the grammar
// DEFINITION object. createParser is the correctness oracle — the emitted parser
// must reproduce its CST byte-for-byte.

import type { CstGrammar, RuleExpr, RuleDecl, PrecLevel } from './types.ts';
import { isKeywordLiteral, collectLiterals } from './grammar-utils.ts';

// ── Static analysis (re-derived; mirrors gen-parser.ts exactly) ──

interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
}

type FirstTok = { lit: string } | { tok: string } | null;
type MixfixInfo = { openLit: string; sepLit: string };

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

function findEntryRule(grammar: CstGrammar): string {
  return grammar.rules[grammar.rules.length - 1].name;
}

/** Build the full static analysis createParser performs, returned as plain data. */
function analyze(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // Precedence table — identical to gen-parser.ts.
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();
  const noUnaryLhsOps = new Set<string>();
  const postfixOpValues = new Set<string>();
  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, { lbp: 0, rbp: level.assoc === 'right' ? bp - 1 : bp, assoc: level.assoc, position: 'prefix' });
      } else if (op.position === 'postfix') {
        postfixOpValues.add(op.value);
        opTable.set(op.value, { lbp: bp, rbp: 0, assoc: level.assoc, position: 'postfix' });
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, { lbp, rbp, assoc: level.assoc, position: 'infix' });
        if (op.noUnaryLhs) noUnaryLhsOps.add(op.value);
      }
    }
  }

  // Pratt rules.
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) if (hasMarker(rule.body)) prattRules.add(rule.name);

  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[] }[] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) leds.push({ expr: alt, items: items.slice(1) });
      else nuds.push(alt);
    }
    return { nuds, leds };
  }
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: RuleExpr[] = [];
    const continuations: RuleExpr[][] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) continuations.push(items.slice(1));
      else atoms.push(alt);
    }
    return { atoms, continuations };
  }
  function isLeftRecursive(rule: RuleDecl): boolean {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    return alts.some(alt => {
      const items = alt.type === 'seq' ? alt.items : [alt];
      return items[0]?.type === 'ref' && items[0].name === rule.name;
    });
  }

  const maxBp = (grammar.precs.length + 1) * 2;
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map(r => [r.name, r]));
  const leftRecSet = new Set<string>(grammar.rules.filter(isLeftRecursive).map(r => r.name));
  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }

  const templateTokenName = grammar.tokens.find(t => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter(t => t.template).map(t => t.name));

  // First-token dispatch.
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }

  // Mixfix operand re-bind shape: `<lit L1> $self <lit L2> …`.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  function mixfixOf(items: RuleExpr[], ruleName: string): MixfixInfo | null {
    if (items.length >= 4 && items[0]?.type === 'literal' && selfRefName(items[1], ruleName) && items[2]?.type === 'literal') {
      return { openLit: items[0].value, sepLit: items[2].value };
    }
    return null;
  }

  // Access-tail + tail-closing LED classification (Pratt).
  // Returns, per Pratt rule, parallel arrays of flags aligned to the leds array.
  const ledMeta = new Map<string, { accessTail: boolean[]; tailClosing: boolean[]; mixfix: (MixfixInfo | null)[]; first: FirstTok[] }>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    const accessTail: boolean[] = [];
    const tailClosing: boolean[] = [];
    const mixfix: (MixfixInfo | null)[] = [];
    const first: FirstTok[] = [];
    for (const led of leds) {
      const it = led.items;
      let isAccessTail = false, isTailClosing = false;
      if (it.length > 0 && it[0].type !== 'op' && it[0].type !== 'postfix') {
        const last = it[it.length - 1];
        const lastIsOperand = selfRefName(last, ruleName);
        const wordConnector = it[0].type === 'literal' && /^[A-Za-z]/.test(it[0].value);
        if (!lastIsOperand && !wordConnector) isAccessTail = true;
        if (last.type === 'not') isTailClosing = true;
      }
      accessTail.push(isAccessTail);
      tailClosing.push(isTailClosing);
      mixfix.push(mixfixOf(led.items, ruleName));
      first.push(firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
    }
    ledMeta.set(ruleName, { accessTail, tailClosing, mixfix, first });
  }

  // Left-rec continuation mixfix.
  const contMeta = new Map<string, (MixfixInfo | null)[]>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    contMeta.set(ruleName, continuations.map(c => mixfixOf(c, ruleName)));
  }

  // Per-alt first-token (non-recursive + left-rec atoms + pratt nuds use these).
  const altFirst = new Map<RuleExpr, FirstTok>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) altFirst.set(alt, firstTokenOf(alt));
  }

  // Nullability.
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'not': return true;
      case 'sep': return true;
      default: return true;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }

  // FIRST sets.
  const firstSets = new Map<string, Set<string> | null>();
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set();
      }
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'prefix') return null;
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
          if (!exprNullable(item)) return acc;
        }
        return acc;
      }
      case 'alt': {
        const acc = new Set<string>();
        for (const item of e.items) {
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
        }
        return acc;
      }
      case 'quantifier': case 'group': return exprFirst(e.body);
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': return new Set();
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue;
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }

  return {
    grammar, tokenNames, opTable, prefixOps, noUnaryLhsOps, postfixOpValues,
    prattRules, leftRecSet, ruleByName, prattClassified, leftRecClassified,
    maxBp, templateTokenName, templateTokenNames, firstTokenOf, altFirst,
    ledMeta, contMeta, nullableRules, firstSets,
  };
}

// ── Code-emission helpers ──

const J = (v: unknown) => JSON.stringify(v);
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Emit a specialized matcher BODY for a RuleExpr — straight-line code that mirrors
 * matchExpr/matchSeq/matchQuantifier/matchSep exactly, but with each step inlined as
 * a direct call (matchLiteral('x'), the ref's parse function, matchToken, an unrolled
 * quantifier loop, the zero-width assertions, sep). Pushes matched leaves/nodes into a
 * local array `out` (declared by the caller). On failure it `pos = <saveVar>; return null`.
 * Returns a string of statements. `saveVar` is the position to restore to on failure.
 *
 * The semantics are a 1:1 transcription of the interpreter's matchExpr switch, so the
 * emitted code accepts/rejects and shapes the CST identically.
 */
class Emitter {
  private buf: string[] = [];
  private tmp = 0;
  // Generated compound-matcher helpers, deduplicated by their structural key so an
  // expr shared across rules emits one helper. Each is a fn returning children[]|null
  // (the matchExpr contract) — control flow is `return`, never `break`, so inlined
  // loops (quantifier/sep) never clash with an enclosing construct's loop.
  private helpers = new Map<string, string>();   // structural key → fn name
  private helperDefs: string[] = [];
  private a: ReturnType<typeof analyze>;
  constructor(a: ReturnType<typeof analyze>) { this.a = a; }
  private id() { return `_t${this.tmp++}`; }

  emit(line = '') { this.buf.push(line); }
  // The compound-matcher helpers are function declarations (hoisted), but they must sit
  // BELOW the module's import statements. The header emits a `${HELPERS}` sentinel right
  // after the imports/tables; we splice the collected helpers there.
  toString() {
    const src = this.buf.join('\n');
    return src.replace('//${HELPERS}', this.helperDefs.join('\n\n'));
  }

  // Reference to a rule's parse function (token refs are inlined where used).
  private ruleFn(name: string) { return `R_${sanitize(name)}`; }

  /**
   * Emit (once) a helper fn for a compound `expr` and return its name. The helper
   * has the matchExpr contract: returns the matched children array or null, with pos
   * restored on failure. Using a function (not inlined statements) means failure is a
   * `return null` and loops use `return`, so nested compounds never have a `break`
   * that escapes to the wrong loop — the one real hazard of inlining the tree-walk.
   */
  private matchFn(expr: RuleExpr): string {
    const key = JSON.stringify(expr);
    const existing = this.helpers.get(key);
    if (existing) return existing;
    const name = `m${this.helpers.size}`;
    this.helpers.set(key, name);
    const body: string[] = [`function ${name}() {`, `  const _save = pos; const out = [];`];
    body.push(this.matchInto(expr, 'out', `pos = _save; return null;`));
    body.push(`  return out;`, `}`);
    this.helperDefs.push(body.join('\n'));
    return name;
  }

  /**
   * Generate statements that match `expr`, appending children to `out`, and on any
   * failure execute `onFail` (which restores pos + returns). Simple/flat shapes are
   * INLINED here (specialized straight-line code, no matchExpr switch); compound
   * shapes (alt / quantifier / sep / nested seq with a contained loop) delegate to a
   * generated helper fn via matchFn — keeping control flow `return`-based.
   */
  matchInto(expr: RuleExpr, out: string, onFail: string): string {
    const a = this.a;
    switch (expr.type) {
      case 'literal': {
        const v = this.id();
        return `const ${v} = matchLiteral(${J(expr.value)}); if (${v} === null) { ${onFail} } ${out}.push(${v});`;
      }
      case 'ref': {
        if (a.tokenNames.has(expr.name)) {
          // Template tokens: route to parseTemplateExpr first (interpolated templates).
          if (a.templateTokenNames.has(expr.name)) {
            const tm = this.id(), lf = this.id();
            return [
              `{ const ${tm} = parseTemplateExpr(); if (${tm} !== null) { ${out}.push(${tm}); }`,
              `  else { const ${lf} = matchToken(${J(expr.name)}); if (${lf} === null) { ${onFail} } ${out}.push(${lf}); } }`,
            ].join('\n');
          }
          const lf = this.id();
          return `const ${lf} = matchToken(${J(expr.name)}); if (${lf} === null) { ${onFail} } ${out}.push(${lf});`;
        }
        // Rule ref: FIRST-set guard (ruleMightStart) baked as a direct check, then call.
        const nd = this.id();
        const guard = this.firstGuard(expr.name);
        return [
          guard ? `if (${guard}) { ${onFail} }` : ``,
          `const ${nd} = ${this.ruleFn(expr.name)}(); if (${nd} === null) { ${onFail} } ${out}.push(${nd});`,
        ].filter(Boolean).join('\n');
      }
      case 'seq': {
        // Inline each item in order; share the caller's onFail (which restores to the
        // seq's save point). matchSeq skips op/prefix/postfix markers. A nested seq is
        // flattened inline too — its failure restores to the SAME save point (the whole
        // matcher fn's _save), exactly like matchSeq's single saved/restore.
        const parts: string[] = [];
        for (const item of expr.items) {
          if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
          parts.push(this.matchInto(item, out, onFail));
        }
        return parts.join('\n');
      }
      case 'alt': {
        // matchExpr 'alt': try each arm (a helper fn) from a shared save; first
        // non-null wins. Splicing the returned children mirrors `return result`.
        const save = this.id(), r = this.id();
        const lines: string[] = [`const ${save} = pos;`, `let ${r} = null;`];
        for (const item of expr.items) {
          const fn = this.matchFn(item);
          lines.push(`if (${r} === null) { pos = ${save}; ${r} = ${fn}(); }`);
        }
        lines.push(`if (${r} === null) { pos = ${save}; ${onFail} }`);
        lines.push(`for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`);
        return lines.join('\n');
      }
      case 'quantifier':
        return this.matchQuantifierInto(expr.body, expr.kind, out, onFail);
      case 'group': {
        // A suppress-carrying group stages the LED-connector exclusion for the next
        // parseRule, then matches its body (same as matchExpr 'group').
        const pre = (expr.suppress && expr.suppress.length)
          ? `suppressNext = new Set(${J(expr.suppress)});`
          : ``;
        return [pre, this.matchInto(expr.body, out, onFail)].filter(Boolean).join('\n');
      }
      case 'not': {
        // Zero-width negative lookahead: succeed (no children) iff body does NOT match.
        const save = this.id(), fn = this.matchFn(expr.body), m = this.id();
        return [
          `{ const ${save} = pos; const ${m} = ${fn}(); pos = ${save};`,
          `  if (${m} !== null) { ${onFail} } }`,
        ].join('\n');
      }
      case 'sameLine':
        return `{ const _tk = peek(); if (!(_tk && !_tk.newlineBefore)) { ${onFail} } }`;
      case 'noCommentBefore':
        return `{ const _tk = peek(); if (!(_tk && !_tk.commentBefore)) { ${onFail} } }`;
      case 'noMultilineFlowBefore':
        return `{ const _tk = peek(); if (!(_tk && !_tk.multilineFlowBefore)) { ${onFail} } }`;
      case 'sep':
        return this.matchSepInto(expr.element, expr.delimiter, out, onFail);
      default:
        // op/prefix/postfix — handled by Pratt; in matchExpr these return null.
        return `{ ${onFail} }`;
    }
  }

  // Quantifier: body is matched via a helper fn (children|null), so the loop here uses
  // `return`/`break` only against ITS OWN while — no nested-loop hazard.
  private matchQuantifierInto(body: RuleExpr, kind: '*' | '+' | '?', out: string, onFail: string): string {
    const fn = this.matchFn(body);
    if (kind === '?') {
      // matchExpr(body) ?? []  → try once; on failure leave pos (the helper restored it).
      const r = this.id();
      return [
        `{ const ${r} = ${fn}();`,
        `  if (${r} !== null) for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]); }`,
      ].join('\n');
    }
    if (kind === '*') {
      const before = this.id(), r = this.id();
      return [
        `while (true) {`,
        `  const ${before} = pos; const ${r} = ${fn}();`,
        `  if (${r} === null) break;`,
        `  if (${r}.length === 0 && pos === ${before}) break;`,
        `  for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`,
        `}`,
      ].join('\n');
    }
    // '+': first mandatory, then the same loop.
    const first = this.id(), before = this.id(), r = this.id();
    return [
      `{ const ${first} = ${fn}(); if (${first} === null) { ${onFail} }`,
      `  for (let _i = 0; _i < ${first}.length; _i++) ${out}.push(${first}[_i]); }`,
      `while (true) {`,
      `  const ${before} = pos; const ${r} = ${fn}();`,
      `  if (${r} === null) break;`,
      `  if (${r}.length === 0 && pos === ${before}) break;`,
      `  for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`,
      `}`,
    ].join('\n');
  }

  // sep = (element (delimiter element)*)?  — never fails (matches zero elements).
  // element matched via helper fn.
  private matchSepInto(element: RuleExpr, delimiter: string, out: string, _onFail: string): string {
    const fn = this.matchFn(element);
    const first = this.id(), dl = this.id(), next = this.id();
    return [
      `{ const ${first} = ${fn}();`,
      `  if (${first} !== null) {`,
      `    for (let _i = 0; _i < ${first}.length; _i++) ${out}.push(${first}[_i]);`,
      `    while (true) {`,
      `      const _ds = pos; const ${dl} = matchLiteral(${J(delimiter)}); if (${dl} === null) { pos = _ds; break; }`,
      `      const ${next} = ${fn}();`,
      `      if (${next} === null) { ${out}.push(${dl}); break; }`,
      `      ${out}.push(${dl}); for (let _i = 0; _i < ${next}.length; _i++) ${out}.push(${next}[_i]);`,
      `    }`,
      `  } }`,
    ].join('\n');
  }

  // Baked FIRST-set guard for a rule ref: the NEGATED ruleMightStart condition (so
  // the caller writes `if (<guard>) { onFail }`). Returns '' when the rule can always
  // start (nullable / null FIRST set) → no guard (matches ruleMightStart returning true).
  firstGuard(name: string): string {
    const a = this.a;
    if (a.nullableRules.has(name)) return '';
    const fs = a.firstSets.get(name);
    if (!fs) return '';
    // ruleMightStart: true iff some key in fs matches peek(); guard = NOT that.
    // Bake the key set; the runtime keyMatchesTok stays shared (small, correct).
    const keys = [...fs];
    return `!ruleMightStartKeys(${J(keys)}, peek())`;
  }
}

// ── Top-level emit ──

export function emitParser(grammar: CstGrammar): string {
  const a = analyze(grammar);
  const e = new Emitter(a);
  const entry = findEntryRule(grammar);

  // Grammar-lite for the lexer: ONLY what createLexer reads (tokens, precs, the
  // literals via rules, markup, indent). We bake the token/precs/markup/indent DATA
  // and replace `rules` with ONE synthetic rule whose body is an `alt` of every
  // literal the real rules contribute — so createLexer's `allLiterals` set (and thus
  // its punctuation table) is identical, without baking the grammar definition.
  const allLits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLits.add(l);
  const litRuleBody: RuleExpr = { type: 'alt', items: [...allLits].map(v => ({ type: 'literal', value: v } as RuleExpr)) };
  const lexGrammar = {
    tokens: grammar.tokens,
    precs: grammar.precs,
    rules: [{ name: '$lits', body: litRuleBody, flags: [] }],
    markup: grammar.markup,
    indent: grammar.indent,
    scopeOverrides: [],
  };

  // ── Header: imports + baked tables + grammar-lite ──
  e.emit(`// GENERATED by src/emit-parser.ts — do not edit. Specialized parser for grammar ${J(grammar.name ?? '')}.`);
  e.emit(`import { createLexer } from ${J(resolveLexerImport())};`);
  e.emit(`import { isKeywordLiteral } from ${J(resolveUtilsImport())};`);
  e.emit(``);
  e.emit(`const LEX_GRAMMAR = ${J(lexGrammar)};`);
  e.emit(`const { tokenize } = createLexer(LEX_GRAMMAR);`);
  e.emit(``);
  // Baked maps. Emit as object literals → Map.
  e.emit(`const opTable = new Map(${J([...a.opTable])});`);
  e.emit(`const prefixOps = new Map(${J([...a.prefixOps])});`);
  e.emit(`const noUnaryLhsOps = new Set(${J([...a.noUnaryLhsOps])});`);
  e.emit(`const postfixOpValues = new Set(${J([...a.postfixOpValues])});`);
  e.emit(`const tokenNames = new Set(${J([...a.tokenNames])});`);
  e.emit(`const templateTokenNames = new Set(${J([...a.templateTokenNames])});`);
  e.emit(`const templateTokenName = ${J(a.templateTokenName ?? null)};`);
  e.emit(`const maxBp = ${a.maxBp};`);
  e.emit(`const ENTRY = ${J(entry)};`);
  e.emit(`const prattRuleNames = new Set(${J([...a.prattRules])});`);
  // The expression rule the template-interpolation fallback (findExprRule) picks:
  // first pratt rule that isn't Type, in declaration order. Bake the resolved name.
  const exprRuleName = (() => {
    for (const r of grammar.rules) if (a.prattRules.has(r.name) && r.name !== 'Type') return r.name;
    return grammar.rules[0].name;
  })();
  e.emit(`const EXPR_RULE = ${J(exprRuleName)};`);
  e.emit(``);
  // Compound-matcher helper fns are spliced in here (after imports/tables).
  e.emit(`//\${HELPERS}`);
  e.emit(``);

  // ── Shared runtime (copied semantics from gen-parser.ts) ──
  emitRuntime(e);

  // ── Per-rule parse functions ──
  emitRuleFns(e, a);

  // ── parse() driver ──
  emitDriver(e, a, entry);

  return e.toString();
}

// The lexer + utils imports are resolved relative to where the emitted file is
// written. Callers write the emitted file and decide the path; by default we emit
// absolute file: paths to THIS repo's src so the emitted file works from anywhere
// (e.g. /tmp). resolveLexerImport returns that absolute specifier.
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
function resolveLexerImport(): string { return pathResolve(__dir, 'gen-lexer.ts'); }
function resolveUtilsImport(): string { return pathResolve(__dir, 'grammar-utils.ts'); }

// ── Runtime: the generic engine state + control loops, emitted verbatim ──
// These are copied from gen-parser.ts so their semantics are byte-identical. The
// ONLY change: where the interpreter called matchExpr(alt)/matchSeq(items) per arm,
// these call the GENERATED per-arm matcher functions (installed via the rule fns).
function emitRuntime(e: Emitter) {
  e.emit(String.raw`
// ── per-parse state (module-level closures, reset by parse()) ──
let tokens = [];
let pos = 0;
let maxPos = 0;
let memo = new Map();
let parseLimit = -1;
let currentPrattContext = null;
let suppressNext = null;
let suppressCur = null;

function peek() {
  if (pos > maxPos) maxPos = pos;
  if (parseLimit >= 0 && pos >= parseLimit) return null;
  return tokens[pos] ?? null;
}
function offset() {
  const t = peek();
  if (t) return t.offset;
  return tokens.length > 0 ? tokens[tokens.length - 1].offset + tokens[tokens.length - 1].text.length : 0;
}
function childOffset(c) { return c.offset; }
function childEnd(c) { return c.end; }

function matchLiteral(value) {
  const tok = peek();
  if (!tok) return null;
  if (isKeywordLiteral(value)) {
    if (tok.type !== '' && tokenNames.has(tok.type) && tok.text === value) {
      pos++;
      return { kind: 'leaf', tokenType: '$keyword', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
    }
    return null;
  }
  if (tok.type === '' && tok.text === value) {
    pos++;
    return { kind: 'leaf', tokenType: '$punct', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  if (value === '>' && tok.type === '' && tok.text.length > 1 && tok.text[0] === '>') {
    const rest = tok.text.slice(1);
    tokens.splice(pos, 1,
      { type: '', text: '>', offset: tok.offset },
      { type: '', text: rest, offset: tok.offset + 1 });
    memo.clear();
    pos++;
    return { kind: 'leaf', tokenType: '$punct', text: '>', offset: tok.offset, end: tok.offset + 1 };
  }
  return null;
}

function matchToken(name) {
  const tok = peek();
  if (!tok) return null;
  if (tok.type === name) {
    pos++;
    return { kind: 'leaf', tokenType: name, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  return null;
}

// FIRST-set membership (shared; baked key arrays are passed by the generated guards).
function keyMatchesTok(key, tok) {
  if (tokenNames.has(key)) {
    if (tok.type === key) return true;
    return templateTokenNames.has(key) && tok.type === '$templateHead';
  }
  if (isKeywordLiteral(key)) {
    return tok.type !== '' && tok.text === key;
  }
  return tok.type === '' && (tok.text === key || tok.text.startsWith(key));
}
function ruleMightStartKeys(keys, tok) {
  if (!tok) return true;
  for (let i = 0; i < keys.length; i++) if (keyMatchesTok(keys[i], tok)) return true;
  return false;
}
// canStart for a baked first-token descriptor ({lit}/{tok}/null).
function canStartFT(ft, tok) {
  if (!ft || !tok) return true;
  return keyMatchesTok(ft.tok !== undefined ? ft.tok : ft.lit, tok);
}

function parseTemplateExpr() {
  const tok = peek();
  if (!tok) return null;
  if (tok.type === templateTokenName) {
    pos++;
    return { kind: 'leaf', tokenType: templateTokenName, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  if (tok.type === '$templateHead') {
    const children = [];
    pos++;
    children.push({ kind: 'leaf', tokenType: '$templateHead', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length });
    const interpRule = currentPrattContext ?? EXPR_RULE;
    while (true) {
      const exprNode = RULES[interpRule]();
      if (exprNode) children.push(exprNode);
      const next = peek();
      if (!next) break;
      if (next.type === '$templateMiddle') {
        pos++;
        children.push({ kind: 'leaf', tokenType: '$templateMiddle', text: next.text, offset: next.offset, end: next.offset + next.text.length });
        continue;
      }
      if (next.type === '$templateTail') {
        pos++;
        children.push({ kind: 'leaf', tokenType: '$templateTail', text: next.text, offset: next.offset, end: next.offset + next.text.length });
        break;
      }
      break;
    }
    const startOff = children.length > 0 ? childOffset(children[0]) : offset();
    const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
    return { kind: 'node', rule: '$template', children, offset: startOff, end: endOff };
  }
  return null;
}
`);
}

// Emit the per-rule parse functions + the RULES dispatch table.
function emitRuleFns(e: Emitter, a: ReturnType<typeof analyze>) {
  const ruleFn = (name: string) => `R_${sanitize(name)}`;
  for (const rule of a.grammar.rules) {
    if (a.prattRules.has(rule.name)) emitPrattRule(e, a, rule);
    else if (a.leftRecSet.has(rule.name)) emitLeftRecRule(e, a, rule);
    else emitNonRecRule(e, a, rule);
  }
  // Dispatch table (string rule name → fn), for parseTemplateExpr's dynamic interp rule.
  e.emit(`const RULES = {`);
  for (const rule of a.grammar.rules) e.emit(`  ${J(rule.name)}: ${ruleFn(rule.name)},`);
  e.emit(`};`);
}

// Non-recursive rule: longest-match over alts (mirrors parseNonRec).
function emitNonRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  e.emit(`function ${ruleFn}() {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let bestNode = null; let bestPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  alts.forEach((alt, i) => {
    const ft = a.altFirst.get(alt) ?? null;
    e.emit(`  // alt ${i}`);
    e.emit(`  if (canStartFT(${J(ft)}, startTok)) {`);
    e.emit(`    pos = saved;`);
    e.emit(`    const children = arm_${sanitize(rule.name)}_${i}();`);
    e.emit(`    if (children !== null && pos > bestPos) {`);
    e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
    e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
    e.emit(`      bestNode = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
    e.emit(`      bestPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  if (bestNode) { pos = bestPos; return bestNode; }`);
  e.emit(`  pos = saved; return null;`);
  e.emit(`}`);
  // Arm matchers.
  alts.forEach((alt, i) => emitArm(e, a, rule.name, i, alt));
}

// Left-recursive (non-Pratt) rule: atom then continuations (mirrors parseLeftRec).
function emitLeftRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const { atoms, continuations } = a.leftRecClassified.get(rule.name)!;
  const contMix = a.contMeta.get(rule.name)!;
  // A left-rec rule, like a Pratt rule, goes through parseRule's memo + context +
  // suppress wrapper in the interpreter — so currentPrattContext is set to this rule
  // (the template-interpolation rule resolution depends on it: a `${…}` hole inside a
  // template-literal TYPE must parse as Type, not the default expression rule).
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${J(rule.name)}, ${ruleFn}_lr); }`);
  e.emit(`function ${ruleFn}_lr(_minBp) {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let node = null; let bestAtomPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  atoms.forEach((atom, i) => {
    const ft = a.altFirst.get(atom) ?? null;
    e.emit(`  if (canStartFT(${J(ft)}, startTok)) {`);
    e.emit(`    pos = saved;`);
    e.emit(`    const children = atom_${sanitize(rule.name)}_${i}();`);
    e.emit(`    if (children !== null && pos > bestAtomPos) {`);
    e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
    e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
    e.emit(`      node = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
    e.emit(`      bestAtomPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  if (!node) { pos = saved; return null; }`);
  e.emit(`  pos = bestAtomPos;`);
  e.emit(`  outer: while (true) {`);
  e.emit(`    const contSaved = pos;`);
  continuations.forEach((cont, i) => {
    e.emit(`    pos = contSaved;`);
    e.emit(`    { let children = cont_${sanitize(rule.name)}_${i}();`);
    if (contMix[i]) {
      e.emit(`      if (children === null) { pos = contSaved; children = matchMixfixLed_${sanitize(rule.name)}_cont_${i}(); }`);
    }
    e.emit(`      if (children !== null) {`);
    e.emit(`        node = { kind: 'node', rule: ${J(rule.name)}, children: [node, ...children], offset: node.offset, end: children.length > 0 ? childEnd(children[children.length - 1]) : node.end };`);
    e.emit(`        continue outer;`);
    e.emit(`      } }`);
  });
  e.emit(`    pos = contSaved; break;`);
  e.emit(`  }`);
  e.emit(`  return node;`);
  e.emit(`}`);
  // Atom + continuation matchers.
  atoms.forEach((atom, i) => emitArmNamed(e, a, `atom_${sanitize(rule.name)}_${i}`, atom));
  continuations.forEach((cont, i) => {
    emitArmNamed(e, a, `cont_${sanitize(rule.name)}_${i}`, { type: 'seq', items: cont } as RuleExpr);
    if (contMix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sanitize(rule.name)}_cont_${i}`, rule.name, cont, contMix[i]!);
  });
}

// Pratt rule (mirrors parsePratt). minBp is a parameter; the NUD/LED arms are
// specialized functions; the control loop is copied verbatim.
function emitPrattRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const sn = sanitize(rule.name);
  const { nuds, leds } = a.prattClassified.get(rule.name)!;
  const meta = a.ledMeta.get(rule.name)!;

  // R_<rule>() wraps parseRule's memo/context handling, then calls the bp-taking core.
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${J(rule.name)}, ${ruleFn}_pratt); }`);
  e.emit(`function ${ruleFn}_pratt(minBp) {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let lhs = null; let bestNudPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  // NUD loop.
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    const ft = a.altFirst.get(nud) ?? null;
    e.emit(`  // nud ${i}`);
    e.emit(`  if (canStartFT(${J(ft)}, startTok)) {`);
    e.emit(`    pos = saved;`);
    if (items[0]?.type === 'prefix') {
      // prefix $ pattern: identical to parsePratt's prefix branch.
      e.emit(`    { const tok = peek();`);
      e.emit(`      if (tok) {`);
      e.emit(`        const info = prefixOps.get(tok.text);`);
      e.emit(`        if (info) {`);
      e.emit(`          pos++;`);
      e.emit(`          const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
      e.emit(`          const rhs = ${ruleFn}_pratt(info.rbp);`);
      e.emit(`          if (rhs && pos > bestNudPos) { lhs = { kind: 'node', rule: ${J(rule.name)}, children: [opLeaf, rhs], offset: opLeaf.offset, end: rhs.end }; bestNudPos = pos; }`);
      e.emit(`        }`);
      e.emit(`      } }`);
    } else {
      e.emit(`    const children = nud_${sn}_${i}();`);
      e.emit(`    if (children !== null && pos > bestNudPos) {`);
      e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
      e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
      e.emit(`      lhs = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
      e.emit(`      bestNudPos = pos;`);
      e.emit(`    }`);
    }
    e.emit(`  }`);
  });
  e.emit(`  if (lhs) pos = bestNudPos;`);
  e.emit(`  if (!lhs) { pos = saved; return null; }`);
  e.emit(`  let tailClosed = false;`);
  e.emit(`  while (true) {`);
  e.emit(`    const tok = peek();`);
  e.emit(`    if (!tok) break;`);
  e.emit(`    const ledSaved = pos;`);
  e.emit(`    let matched = false;`);
  // Non-op LED loop.
  leds.forEach((led, i) => {
    if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') return; // operator LEDs handled below
    const ft = meta.first[i];
    const conds: string[] = [];
    conds.push(`maxBp > minBp`);
    if (meta.accessTail[i]) conds.push(`!(tailClosed)`);
    // suppress: skip a LED whose first literal connector is in suppressCur.
    const firstLit = (led.items[0]?.type === 'literal') ? led.items[0].value : null;
    if (firstLit !== null) conds.push(`!(suppressCur && suppressCur.has(${J(firstLit)}))`);
    conds.push(`canStartFT(${J(ft)}, tok)`);
    e.emit(`    // led ${i}`);
    e.emit(`    if (!matched && ${conds.join(' && ')}) {`);
    e.emit(`      pos = ledSaved;`);
    e.emit(`      let children = led_${sn}_${i}();`);
    if (meta.mixfix[i]) {
      e.emit(`      if (children === null) { pos = ledSaved; children = matchMixfixLed_${sn}_led_${i}(); }`);
    }
    e.emit(`      if (children !== null) {`);
    e.emit(`        lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, ...children], offset: lhs.offset, end: children.length > 0 ? childEnd(children[children.length - 1]) : lhs.end };`);
    if (meta.tailClosing[i]) e.emit(`        tailClosed = true;`);
    e.emit(`        matched = true;`);
    e.emit(`      }`);
    e.emit(`    }`);
  });
  e.emit(`    if (matched) continue;`);
  // Operator LED ($ op $ / postfix), copied verbatim.
  e.emit(`    const tokKey = tok.text;`);
  e.emit(`    const info = opTable.get(tokKey);`);
  e.emit(`    if (info && info.lbp > minBp) {`);
  e.emit(`      if (info.position === 'postfix') {`);
  e.emit(`        if (!tailClosed) {`);
  e.emit(`          pos++;`);
  e.emit(`          const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
  e.emit(`          lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, opLeaf], offset: lhs.offset, end: opLeaf.end };`);
  e.emit(`          tailClosed = true; matched = true;`);
  e.emit(`        }`);
  e.emit(`      } else {`);
  e.emit(`        if (noUnaryLhsOps.has(tokKey) && lhs.kind === 'node') {`);
  e.emit(`          const head = lhs.children[0];`);
  e.emit(`          if (head && head.kind === 'leaf' && head.tokenType === '$operator' && prefixOps.has(head.text) && !postfixOpValues.has(head.text)) { return null; }`);
  e.emit(`        }`);
  e.emit(`        pos++;`);
  e.emit(`        const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
  e.emit(`        const rhs = ${ruleFn}_pratt(info.rbp);`);
  e.emit(`        if (rhs) { lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end }; matched = true; }`);
  e.emit(`        else { pos = ledSaved; }`);
  e.emit(`      }`);
  e.emit(`      if (matched) continue;`);
  e.emit(`    }`);
  e.emit(`    if (!matched) { pos = ledSaved; break; }`);
  e.emit(`  }`);
  e.emit(`  return lhs;`);
  e.emit(`}`);

  // NUD arm matchers (skip prefix nuds — handled inline above).
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    if (items[0]?.type === 'prefix') return;
    emitArmNamed(e, a, `nud_${sn}_${i}`, nud);
  });
  // LED arm matchers (skip operator leds).
  leds.forEach((led, i) => {
    if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') return;
    emitArmNamed(e, a, `led_${sn}_${i}`, { type: 'seq', items: led.items } as RuleExpr);
    if (meta.mixfix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sn}_led_${i}`, rule.name, led.items, meta.mixfix[i]!);
  });
}

// Emit `arm_<rule>_<i>()` — a matchExpr(alt) specialization returning children|null.
function emitArm(e: Emitter, a: ReturnType<typeof analyze>, ruleName: string, i: number, alt: RuleExpr) {
  emitArmNamed(e, a, `arm_${sanitize(ruleName)}_${i}`, alt);
}

// Emit a named matcher fn for `expr`: returns the matched children array or null,
// restoring pos on failure (the matchExpr/matchSeq contract).
function emitArmNamed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, expr: RuleExpr) {
  e.emit(`function ${fnName}() {`);
  e.emit(`  const _save = pos; const out = [];`);
  e.emit(e.matchInto(expr, 'out', 'pos = _save; return null;'));
  e.emit(`  return out;`);
  e.emit(`}`);
}

// Emit a specialized matchMixfixLed for a LED/cont (mirrors the interpreter's
// matchMixfixLed exactly; the rest-matching uses an inlined matchSeq of items[3:]).
function emitMixfixLed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, ruleName: string, items: RuleExpr[], info: MixfixInfo) {
  const ruleFn = `R_${sanitize(ruleName)}`;
  const restItems = items.slice(3);
  e.emit(`function ${fnName}() {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  const openLeaf = matchLiteral(${J(info.openLit)});`);
  e.emit(`  if (!openLeaf) { pos = saved; return null; }`);
  e.emit(`  const afterOpen = pos;`);
  e.emit(`  const operand = ${ruleFn}();`);
  e.emit(`  if (!operand) { pos = saved; return null; }`);
  e.emit(`  const greedyEnd = pos;`);
  e.emit(`  if (matchLiteral(${J(info.sepLit)})) { pos = saved; return null; }`);
  e.emit(`  let depth = 0; const candidates = [];`);
  e.emit(`  for (let i = afterOpen; i < greedyEnd; i++) {`);
  e.emit(`    const t = tokens[i];`);
  e.emit(`    if (t.type !== '') continue;`);
  e.emit(`    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;`);
  e.emit(`    else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;`);
  e.emit(`    else if (depth === 0 && t.text === ${J(info.sepLit)}) candidates.push(i);`);
  e.emit(`  }`);
  e.emit(`  for (const sepIdx of candidates) {`);
  e.emit(`    pos = afterOpen;`);
  e.emit(`    const prevLimit = parseLimit; parseLimit = sepIdx;`);
  e.emit(`    const reOperand = ${ruleFn}();`);
  e.emit(`    parseLimit = prevLimit;`);
  e.emit(`    if (!reOperand || pos !== sepIdx) continue;`);
  e.emit(`    const sepLeaf = matchLiteral(${J(info.sepLit)});`);
  e.emit(`    if (!sepLeaf) continue;`);
  // rest = matchSeq(items[3:]) — inline.
  e.emit(`    const rest = (function(){ const _save = pos; const out = [];`);
  e.emit(e.matchInto({ type: 'seq', items: restItems } as RuleExpr, 'out', 'pos = _save; return null;'));
  e.emit(`      return out; })();`);
  e.emit(`    if (rest === null) continue;`);
  e.emit(`    return [openLeaf, reOperand, sepLeaf, ...rest];`);
  e.emit(`  }`);
  e.emit(`  pos = saved; return null;`);
  e.emit(`}`);
}

// Emit parseRuleEntry (memo + context handling for pratt/left-rec rules, mirrors
// parseRule's pratt/left-rec branch) and the parse() driver.
function emitDriver(e: Emitter, a: ReturnType<typeof analyze>, entry: string) {
  e.emit(String.raw`
// parseRule for a pratt/left-rec rule: memo + context + suppress, then the core.
function parseRuleEntry(name, core) {
  const mySup = suppressNext;
  suppressNext = null;
  const capped = parseLimit >= 0;
  const start = pos;
  let m = memo.get(name);
  if (!mySup && !capped) {
    const hit = m && m.get(start);
    if (hit !== undefined) { pos = hit.end; return hit.node; }
  }
  const prevContext = currentPrattContext;
  currentPrattContext = name;
  const prevSup = suppressCur;
  suppressCur = mySup;
  let result;
  try {
    result = core(0);
  } finally {
    currentPrattContext = prevContext;
    suppressCur = prevSup;
  }
  if (!mySup && !capped) {
    if (!m) { m = new Map(); memo.set(name, m); }
    m.set(start, { node: result, end: pos });
  }
  return result;
}

export function parse(source, entryRule) {
  tokens = tokenize(source);
  pos = 0;
  maxPos = 0;
  memo = new Map();
  parseLimit = -1;
  currentPrattContext = null;
  suppressNext = null;
  suppressCur = null;

  const entry = entryRule ?? ENTRY;
  if (tokens.length === 0) {
    return { kind: 'node', rule: entry, children: [], offset: 0, end: 0 };
  }
  const result = RULES[entry]();
  if (!result) {
    const tok = peek();
    throw new Error('Parse error at offset ' + (tok?.offset ?? 0) + ': unexpected ' + (tok ? "'" + tok.text + "'" : 'end of input') + farthest(pos));
  }
  if (pos < tokens.length) {
    const tok = tokens[pos];
    throw new Error('Parse error at offset ' + tok.offset + ": unexpected '" + tok.text + "' after successful parse" + farthest(pos));
  }
  return result;

  function farthest(errPos) {
    if (maxPos <= errPos || maxPos >= tokens.length) return '';
    const tok = tokens[maxPos];
    return ' [farthest: offset ' + tok.offset + " near '" + tok.text.slice(0, 20) + "']";
  }
}

export { tokenize };
export function createParser() { return { parse, tokenize }; }
`);
}
