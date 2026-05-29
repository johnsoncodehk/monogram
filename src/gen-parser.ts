import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { isKeywordLiteral } from './grammar-utils.ts';
import { createLexer, type Token } from './gen-lexer.ts';

// ── CST output ──

export interface CstNode {
  kind: 'node';
  rule: string;
  children: CstChild[];
  offset: number;
  end: number;
}

export interface CstLeaf {
  kind: 'leaf';
  tokenType: string;
  text: string;
  offset: number;
  end: number;
}

export type CstChild = CstNode | CstLeaf;

// ── Precedence info ──

interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
}

// ── Parser ──

export function createParser(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // The lexer is a separate stage, built from the same grammar (token defs + lexer hints).
  const { tokenize } = createLexer(grammar);

  // Build precedence table
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();

  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, {
          lbp: 0,
          rbp: level.assoc === 'right' ? bp - 1 : bp,
          assoc: level.assoc,
          position: 'prefix',
        });
      } else if (op.position === 'postfix') {
        opTable.set(op.value, {
          lbp: bp,
          rbp: 0,
          assoc: level.assoc,
          position: 'postfix',
        });
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, { lbp, rbp, assoc: level.assoc, position: 'infix' });
      }
    }
  }

  // Classify rules: which use Pratt parsing
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) {
    if (hasMarker(rule.body)) prattRules.add(rule.name);
  }

  // For Pratt rules, split alternatives into NUD (atoms/prefix) and LED (left-recursive)
  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[] }[] = [];

    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) {
        // Left-recursive: LED
        leds.push({ expr: alt, items: items.slice(1) });
      } else if (items.length >= 2 && items[0]?.type === 'prefix') {
        // prefix $ → NUD with prefix handling
        nuds.push(alt);
      } else {
        nuds.push(alt);
      }
    }
    return { nuds, leds };
  }

  // For non-Pratt left-recursive rules, split into atoms and continuations
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: RuleExpr[] = [];
    const continuations: RuleExpr[][] = [];

    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) {
        continuations.push(items.slice(1));
      } else {
        atoms.push(alt);
      }
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

  // Maximum binding power for non-operator LED patterns (member access, call, etc.)
  const maxBp = (grammar.precs.length + 1) * 2;
  const PROF = !!process.env.PROF;   // per-rule call profiling (diagnostic)

  // ── Precomputed per-rule analysis ──
  // Rule lookup, left-recursion, and the NUD/LED (Pratt) / atom-continuation
  // (left-rec) classification are functions of the static grammar only, so we
  // compute them ONCE here instead of re-deriving them on every parse call.
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map(r => [r.name, r]));
  const leftRecSet = new Set<string>(grammar.rules.filter(isLeftRecursive).map(r => r.name));
  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }
  // The template token(s): the parser routes their tokens to the interpolation-aware
  // parseTemplateExpr path (the lexer owns producing them — see gen-lexer.ts).
  const templateTokenName = grammar.tokens.find(t => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter(t => t.template).map(t => t.name));

  // ── First-token dispatch ──
  // For each alternative, the token it MUST begin with, if that is statically
  // knowable (a leading literal or token ref). When known, the alternative can
  // be skipped outright if the current token can't be its first token — so the
  // alternative loops branch on the lookahead instead of trying every arm.
  // `null` = not statically knowable (rule ref / prefix / optional first) → always try.
  type FirstTok = { lit: string } | { tok: string } | null;
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }
  const firstOf = new Map<RuleExpr, FirstTok>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) firstOf.set(alt, firstTokenOf(alt));
  }
  // Does a FIRST-set key (a token name, or a literal keyword/punctuation) match a token?
  function keyMatchesTok(key: string, tok: Token): boolean {
    if (tokenNames.has(key)) {
      if (tok.type === key) return true;
      return templateTokenNames.has(key) && tok.type === '$templateHead';  // interpolated template
    }
    if (isKeywordLiteral(key)) {
      return tok.type !== '' && tok.text === key;       // keyword → ident token
    }
    return tok.type === '' && (tok.text === key || tok.text.startsWith(key));  // punctuation (startsWith covers split `>>`)
  }
  // Conservative: return true unless the alternative provably cannot start here.
  function canStart(first: FirstTok | undefined, tok: Token | null): boolean {
    if (!first || !tok) return true;
    return keyMatchesTok('tok' in first ? first.tok : first.lit, tok);
  }
  // First token of each Pratt LED continuation (the element right after `$`), so
  // the LED loop can skip leds whose continuation can't begin with the lookahead
  // — that loop was otherwise ~97% wasted matchSeq attempts that fail on token 1.
  const ledFirst = new Map<object, FirstTok>();
  for (const { leds } of prattClassified.values()) {
    for (const led of leds) ledFirst.set(led, firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
  }

  // ── Mixfix operand re-bound info ──
  // A LED of the shape `<lit L1> $self <lit L2> …` (e.g. a ternary `? $ : $`) has
  // an *inner* operand (`$self`, the bit between L1 and L2) that the greedy
  // non-backtracking engine may over-consume — swallowing the L2 the operator
  // itself needs (the classic conditional-`?:` vs arrow-return-type-`:` clash:
  // `b ? (c) : d => e`, where `(c): d => e` parses as one arrow, leaving no `:`).
  // When the normal match of such a LED fails, the LED loop retries the inner
  // operand with a position cap so it stops before an L2 at the operator's own
  // bracket-nesting depth, freeing that L2 for the operator. Language-agnostic:
  // keyed purely on the structural shape, no knowledge of `?`/`:`/arrows.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  type MixfixInfo = { openLit: string; sepLit: string };
  const ledMixfix = new Map<object, MixfixInfo>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const it = led.items;
      if (it.length >= 4
        && it[0]?.type === 'literal'
        && selfRefName(it[1], ruleName)
        && it[2]?.type === 'literal') {
        ledMixfix.set(led, { openLit: it[0].value, sepLit: it[2].value });
      }
    }
  }

  // ── FIRST sets ──
  // The set of tokens each rule can begin with (null = "anything" — left-recursive
  // / prefix-operator rules, which can't be characterized). Used to skip parsing a
  // non-nullable rule reference outright when the lookahead can't start it — this
  // is what stops e.g. DecoratorExpr/TypeParams being speculatively parsed (and
  // failing) at every member/parameter position.
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'sep': return true;                                   // sep matches zero elements
      default: return true;                                      // op/prefix/postfix markers don't consume
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }
  const firstSets = new Map<string, Set<string> | null>();   // null = top (anything)
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set();  // unresolved → empty this round
      }
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'prefix') return null;               // prefix op → any operator token: give up
          if (item.type === 'op' || item.type === 'postfix') continue;  // non-consuming here
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
          if (!exprNullable(item)) return acc;                   // stop at first non-nullable element
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
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue;                               // null is terminal
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }
  // Can a (non-nullable) rule possibly begin with this token? Used to skip dead parseRule calls.
  function ruleMightStart(name: string, tok: Token | null): boolean {
    if (!tok || nullableRules.has(name)) return true;
    const fs = firstSets.get(name);
    if (!fs) return true;                                        // null/unknown → don't filter
    for (const k of fs) if (keyMatchesTok(k, tok)) return true;
    return false;
  }

  // ── Parser core ──

  const profCounts = new Map<string, number>();
  function parse(source: string, entryRule?: string): CstNode {
    const tokens = tokenize(source);
    let pos = 0;
    let maxPos = 0;   // farthest token index the parser ever attempted to read (diagnostic)
    // Packrat memo for pratt/left-recursive rules (Expr, Type, …): cache the
    // parse result + end position by start position, so backtracking doesn't
    // re-parse the same rule at the same spot. Sound because those rules reset
    // currentPrattContext (result is context-independent). Cleared on a `>>`
    // token splice (matchLiteral), which shifts later positions.
    const memo = new Map<string, Map<number, { node: CstNode | null; end: number }>>();

    // Bounded-parse cap (token index). When >= 0, no token at index >= parseLimit
    // may be consumed — i.e. a sub-parse is forced to stop before that token. Used
    // for the mixfix-operand re-parse (see matchMixfixLed): re-running an over-greedy
    // operand so it leaves a required separator for the enclosing mixfix operator.
    // `null`-equivalent is -1 (no cap). A capped parse is position+cap dependent,
    // so it bypasses the packrat memo (which is keyed by start position only).
    let parseLimit = -1;

    function peek(): Token | null {
      if (pos > maxPos) maxPos = pos;
      if (parseLimit >= 0 && pos >= parseLimit) return null;
      return tokens[pos] ?? null;
    }

    function offset(): number {
      return peek()?.offset ?? (tokens.length > 0 ? tokens[tokens.length - 1].offset + tokens[tokens.length - 1].text.length : 0);
    }

    // Match a literal string against current token
    function matchLiteral(value: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;

      if (isKeywordLiteral(value)) {
        // Keyword literal: match against Ident token with same text
        if (tok.type !== '' && tokenNames.has(tok.type) && tok.text === value) {
          pos++;
          return { kind: 'leaf', tokenType: '$keyword', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
        }
        return null;
      }
      // Punctuation literal
      if (tok.type === '' && tok.text === value) {
        pos++;
        return { kind: 'leaf', tokenType: '$punct', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
      }
      // Split multi-`>` tokens: `>>`, `>>>`, `>>=`, `>>>=` can yield a single `>`
      if (value === '>' && tok.type === '' && tok.text.length > 1 && tok.text[0] === '>') {
        const rest = tok.text.slice(1);
        tokens.splice(pos, 1,
          { type: '', text: '>', offset: tok.offset },
          { type: '', text: rest, offset: tok.offset + 1 },
        );
        memo.clear();   // splice shifts later token indices → memo entries are stale
        pos++;
        return { kind: 'leaf', tokenType: '$punct', text: '>', offset: tok.offset, end: tok.offset + 1 };
      }
      return null;
    }

    // Match a token ref
    function matchToken(name: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === name) {
        pos++;
        return { kind: 'leaf', tokenType: name, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
      }
      return null;
    }

    let currentPrattContext: string | null = null;

    function parseTemplateExpr(): CstChild | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === templateTokenName) {
        pos++;
        return { kind: 'leaf', tokenType: templateTokenName, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
      }
      if (tok.type === '$templateHead') {
        const children: CstChild[] = [];
        pos++;
        children.push({ kind: 'leaf', tokenType: '$templateHead', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length });
        const interpRule = currentPrattContext ?? findExprRule();
        while (true) {
          const exprNode = parseRule(interpRule);
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

    function findExprRule(): string {
      for (const r of grammar.rules) {
        if (prattRules.has(r.name) && r.name !== 'Type') return r.name;
      }
      return grammar.rules[0].name;
    }

    // Parse a rule by name
    function parseRule(name: string): CstNode | null {
      if (PROF) profCounts.set(name, (profCounts.get(name) ?? 0) + 1);
      const rule = ruleByName.get(name);
      if (!rule) throw new Error(`Unknown rule: ${name}`);

      const isPratt = prattRules.has(name);
      const isLeftRec = leftRecSet.has(name);
      // Non-recursive rules don't reset context and aren't memoized.
      if (!isPratt && !isLeftRec) return parseNonRec(rule);

      // Memoizable (pratt / left-recursive): look up by start position.
      // A capped parse (parseLimit active) is position+cap dependent, so it must
      // not read or write the position-keyed packrat memo.
      const capped = parseLimit >= 0;
      const start = pos;
      let m = memo.get(name);
      if (!capped) {
        const hit = m && m.get(start);
        if (hit !== undefined) { pos = hit.end; return hit.node; }
      }

      const prevContext = currentPrattContext;
      currentPrattContext = name;
      let result: CstNode | null;
      try {
        result = isPratt ? parsePratt(rule, 0) : parseLeftRec(rule);
      } finally {
        currentPrattContext = prevContext;
      }
      if (!capped) {
        if (!m) { m = new Map(); memo.set(name, m); }
        m.set(start, { node: result, end: pos });
      }
      return result;
    }

    // Non-recursive rule: try alternatives, pick longest match
    function parseNonRec(rule: RuleDecl): CstNode | null {
      const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
      const saved = pos;

      let bestNode: CstNode | null = null;
      let bestPos = saved;
      const startTok = tokens[saved] ?? null;

      for (const alt of alts) {
        if (!canStart(firstOf.get(alt), startTok)) continue;
        pos = saved;
        const children = matchExpr(alt);
        if (children !== null && pos > bestPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          bestNode = { kind: 'node', rule: rule.name, children, offset: startOff, end: endOff };
          bestPos = pos;
        }
      }

      if (bestNode) { pos = bestPos; return bestNode; }
      pos = saved;
      return null;
    }

    // Left-recursive rule without Pratt: parse atom then try continuations
    function parseLeftRec(rule: RuleDecl): CstNode | null {
      const { atoms, continuations } = leftRecClassified.get(rule.name)!;
      const saved = pos;

      // Parse atom (longest match)
      let node: CstNode | null = null;
      let bestAtomPos = saved;
      const startTok = tokens[saved] ?? null;
      for (const atom of atoms) {
        if (!canStart(firstOf.get(atom), startTok)) continue;
        pos = saved;
        const children = matchExpr(atom);
        if (children !== null && pos > bestAtomPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          node = { kind: 'node', rule: rule.name, children, offset: startOff, end: endOff };
          bestAtomPos = pos;
        }
      }
      if (!node) { pos = saved; return null; }
      pos = bestAtomPos;

      // Try continuations repeatedly
      outer: while (true) {
        const contSaved = pos;
        for (const cont of continuations) {
          pos = contSaved;
          const children = matchSeq(cont);
          if (children !== null) {
            node = {
              kind: 'node',
              rule: rule.name,
              children: [node, ...children],
              offset: node.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : node.end,
            };
            continue outer;
          }
        }
        pos = contSaved;
        break;
      }

      return node;
    }

    // Pratt parser for rules with op/prefix/postfix
    function parsePratt(rule: RuleDecl, minBp: number): CstNode | null {
      const { nuds, leds } = prattClassified.get(rule.name)!;
      const saved = pos;

      // NUD: parse atom or prefix (longest match)
      let lhs: CstNode | null = null;
      let bestNudPos = saved;
      const startTok = tokens[saved] ?? null;
      for (const nud of nuds) {
        if (!canStart(firstOf.get(nud), startTok)) continue;
        pos = saved;
        const items = nud.type === 'seq' ? nud.items : [nud];

        // prefix $ pattern
        if (items[0]?.type === 'prefix') {
          const tok = peek();
          if (tok) {
            const key = tok.text;
            const info = prefixOps.get(key);
            if (info) {
              pos++;
              const opLeaf: CstLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
              const rhs = parsePratt(rule, info.rbp);
              if (rhs && pos > bestNudPos) {
                lhs = { kind: 'node', rule: rule.name, children: [opLeaf, rhs], offset: opLeaf.offset, end: rhs.end };
                bestNudPos = pos;
              }
            }
          }
          continue;
        }

        const children = matchExpr(nud);
        if (children !== null && pos > bestNudPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          lhs = { kind: 'node', rule: rule.name, children, offset: startOff, end: endOff };
          bestNudPos = pos;
        }
      }
      if (lhs) pos = bestNudPos;

      if (!lhs) { pos = saved; return null; }

      // LED loop
      while (true) {
        const tok = peek();
        if (!tok) break;

        const ledSaved = pos;
        let matched = false;

        // Check non-op LED patterns first ($ '.' Ident, $ '<' ... '>' '(', etc.)
        for (const led of leds) {
          if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') continue;
          if (maxBp <= minBp) continue;
          if (!canStart(ledFirst.get(led), tok)) continue;   // first-token dispatch for LED continuations

          pos = ledSaved;
          let children = matchSeq(led.items);
          // Mixfix operand re-bound: if a `<L1> $ <L2> …` LED failed, the inner
          // operand may have over-consumed the L2 it needs — retry it capped.
          if (children === null && ledMixfix.has(led)) {
            pos = ledSaved;
            children = matchMixfixLed(led, rule.name, ledMixfix.get(led)!);
          }
          if (children !== null) {
            lhs = {
              kind: 'node',
              rule: rule.name,
              children: [lhs, ...children],
              offset: lhs.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : lhs.end,
            };
            matched = true;
            break;
          }
        }

        if (matched) continue;

        // Then check $ op $ pattern
        const tokKey = tok.text;
        const info = opTable.get(tokKey);
        if (info && info.lbp > minBp) {
          if (info.position === 'postfix') {
            pos++;
            const opLeaf: CstLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
            lhs = { kind: 'node', rule: rule.name, children: [lhs, opLeaf], offset: lhs.offset, end: opLeaf.end };
            matched = true;
          } else {
            pos++;
            const opLeaf: CstLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
            const rhs = parsePratt(rule, info.rbp);
            if (rhs) {
              lhs = { kind: 'node', rule: rule.name, children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end };
              matched = true;
            } else {
              pos = ledSaved;
            }
          }
          if (matched) continue;
        }

        if (!matched) { pos = ledSaved; break; }
      }

      return lhs;
    }

    // Match a RuleExpr, return children or null
    function matchExpr(expr: RuleExpr): CstChild[] | null {
      switch (expr.type) {
        case 'literal': {
          const leaf = matchLiteral(expr.value);
          return leaf ? [leaf] : null;
        }
        case 'ref': {
          if (tokenNames.has(expr.name)) {
            // Template tokens: also handle interpolated templates
            if (templateTokenNames.has(expr.name)) {
              const tmpl = parseTemplateExpr();
              if (tmpl) return [tmpl];
            }
            const leaf = matchToken(expr.name);
            return leaf ? [leaf] : null;
          }
          // Skip the rule entirely if the lookahead can't begin it (and it can't
          // match empty) — avoids speculatively parsing+failing rules like
          // DecoratorExpr/TypeParams at every position.
          if (!ruleMightStart(expr.name, peek())) return null;
          const node = parseRule(expr.name);
          return node ? [node] : null;
        }
        case 'seq':
          return matchSeq(expr.items);
        case 'alt': {
          const saved = pos;
          for (const item of expr.items) {
            pos = saved;
            const result = matchExpr(item);
            if (result !== null) return result;
          }
          pos = saved;
          return null;
        }
        case 'quantifier':
          return matchQuantifier(expr.body, expr.kind);
        case 'group':
          return matchExpr(expr.body);
        case 'sep':
          return matchSep(expr.element, expr.delimiter);
        default:
          // op / prefix / postfix markers are handled by the Pratt parser.
          return null;
      }
    }

    function matchSeq(items: RuleExpr[]): CstChild[] | null {
      const saved = pos;
      const children: CstChild[] = [];
      for (const item of items) {
        // Skip op/prefix/postfix markers in sequence (handled by Pratt)
        if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
        const result = matchExpr(item);
        if (result === null) { pos = saved; return null; }
        children.push(...result);
      }
      return children;
    }

    // Mixfix operand re-bound (see ledMixfix). The LED shape is
    // `<openLit> $self <sepLit> …rest`; the normal match already failed. Re-parse
    // the inner `$self` operand with a position cap so it stops before a `sepLit`
    // token at the *same* bracket depth as `openLit`, freeing that token for the
    // operator's own separator, then match `sepLit` and the rest uncapped.
    // `pos` is at `openLit` on entry. Returns the LED children or null (restored).
    function matchMixfixLed(led: { items: RuleExpr[] }, ruleName: string, info: { openLit: string; sepLit: string }): CstChild[] | null {
      const saved = pos;
      const openLeaf = matchLiteral(info.openLit);
      if (!openLeaf) { pos = saved; return null; }
      const afterOpen = pos;

      // Greedy parse of the operand, to (a) confirm the separator is missing right
      // after it (otherwise the failure is elsewhere → don't apply) and (b) bound
      // the scan window.
      const operand = parseRule(ruleName);
      if (!operand) { pos = saved; return null; }
      const greedyEnd = pos;
      // If the separator DOES match here, the LED's failure was later in `rest`,
      // not operand over-consumption — re-bounding wouldn't help.
      if (matchLiteral(info.sepLit)) { pos = saved; return null; }

      // Candidate separator positions: `sepLit` tokens at bracket depth 0 within
      // (afterOpen, greedyEnd). A nested same-shape operator (e.g. a nested
      // ternary) contributes its own depth-0 `sepLit`, so we try candidates in
      // order and accept the first where the capped operand lands exactly on it.
      let depth = 0;
      const candidates: number[] = [];
      for (let i = afterOpen; i < greedyEnd; i++) {
        const t = tokens[i];
        if (t.type !== '') continue;                 // only punctuation carries brackets/sep
        if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
        else if (depth === 0 && t.text === info.sepLit) candidates.push(i);
      }

      for (const sepIdx of candidates) {
        // Re-parse the operand capped so it cannot consume the token at sepIdx;
        // accept only if the operand consumes everything up to exactly there.
        pos = afterOpen;
        const prevLimit = parseLimit;
        parseLimit = sepIdx;
        const reOperand = parseRule(ruleName);
        parseLimit = prevLimit;
        if (!reOperand || pos !== sepIdx) continue;

        const sepLeaf = matchLiteral(info.sepLit);
        if (!sepLeaf) continue;
        const rest = matchSeq(led.items.slice(3));
        if (rest === null) continue;
        return [openLeaf, reOperand, sepLeaf, ...rest];
      }

      pos = saved;
      return null;
    }

    function matchQuantifier(body: RuleExpr, kind: '*' | '+' | '?'): CstChild[] | null {
      if (kind === '?') {
        const result = matchExpr(body);
        return result ?? [];
      }
      if (kind === '*') {
        const children: CstChild[] = [];
        while (true) {
          const saved = pos;
          const result = matchExpr(body);
          if (result === null) { pos = saved; break; }
          if (result.length === 0 && pos === saved) break;
          children.push(...result);
        }
        return children;
      }
      // kind === '+'
      const first = matchExpr(body);
      if (first === null) return null;
      const children: CstChild[] = [...first];
      while (true) {
        const saved = pos;
        const result = matchExpr(body);
        if (result === null) { pos = saved; break; }
        if (result.length === 0 && pos === saved) break;
        children.push(...result);
      }
      return children;
    }

    function matchSep(element: RuleExpr, delimiter: string): CstChild[] | null {
      // sep = (element (delimiter element)*)?
      const saved = pos;
      const first = matchExpr(element);
      if (first === null) { pos = saved; return []; }
      const children: CstChild[] = [...first];
      while (true) {
        const delimSaved = pos;
        const delimLeaf = matchLiteral(delimiter);
        if (!delimLeaf) { pos = delimSaved; break; }
        const next = matchExpr(element);
        if (next === null) { children.push(delimLeaf); break; }   // trailing delimiter OK
        children.push(delimLeaf, ...next);
      }
      return children;
    }

    // Entry
    const entry = entryRule ?? findEntryRule(grammar);
    if (tokens.length === 0) {
      return { kind: 'node', rule: entry, children: [], offset: 0, end: 0 };
    }
    const result = parseRule(entry);
    if (!result) {
      const tok = peek();
      throw new Error(`Parse error at offset ${tok?.offset ?? 0}: unexpected ${tok ? `'${tok.text}'` : 'end of input'}${farthest(pos)}`);
    }
    // Check all input consumed
    if (pos < tokens.length) {
      const tok = tokens[pos];
      throw new Error(`Parse error at offset ${tok.offset}: unexpected '${tok.text}' after successful parse${farthest(pos)}`);
    }
    return result;

    // Diagnostic: when backtracking reached further than the reported error
    // position, point at that deepest spot — it's usually nearer the real cause.
    function farthest(errPos: number): string {
      if (maxPos <= errPos || maxPos >= tokens.length) return '';
      const tok = tokens[maxPos];
      return ` [farthest: offset ${tok.offset} near '${tok.text.slice(0, 20)}']`;
    }
  }

  return { parse, tokenize, profCounts };
}

// ── Helpers ──

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

function childOffset(child: CstChild): number {
  return child.offset;
}

function childEnd(child: CstChild): number {
  return child.end;
}
