// Generate per-rule, per-ARM destructurers for a grammar's CST — the VALUE-level
// sibling of gen-ast-types.ts. For every rule it emits
//
//   export type <Rule>Match = { arm: 'if', expr: NodeEntry<'Expr'>, … } | …
//   export function match<Rule>(t: TreeAccess, n: NodeEntry<'Rule'>, src: string): <Rule>Match
//
// ARENA-NATIVE: matchers read the emitted parser's arena through the TreeAccess
// interface (the emitted module's `tree` export satisfies it) — a node is an id, a
// leaf is a token-encoded entry; nothing is materialized to match.
//
// The matcher re-derives WHICH grammar alternative a node matched and binds its
// children to named fields — the discrimination the parser performed and the CST does
// not record. It is derived from the SAME grammar facts the parser dispatch uses, so
// it encodes the things hand-written consumers get wrong: tokenType-exact literal
// checks ($keyword vs Ident ties resolved by what the CST actually says), the
// interpolated-template dual (a Template token ref matches a Template LEAF or a
// '$template' NODE), pratt operator forms, sep()'s consumed trailing delimiter, and
// greedy no-backtracking quantifier semantics (mirroring matchSeq/matchQuantifier —
// the children of a parsed node always reflect the greedy success path, so local
// greedy decisions reproduce the parse exactly).
//
// Validated by test/cst-match-totality.ts: every node of every generated-corpus CST
// must be matched by exactly its rule's matcher, consuming all children.
import type { CstGrammar, PrecOperator, RuleDecl, RuleExpr } from './types.ts';
import { isKeywordLiteral } from './grammar-utils.ts';

// ── Arm step plan ──

type Card = 'one' | 'opt' | 'many';

interface Capture {
  name: string;    // local slot (branch rendering prefixes it)
  field: string;   // result-object / type key — frozen at plan time
  tsType: string;
  card: Card;
}

type Step =
  | { kind: 'lit'; text: string; tt: '$keyword' | '$punct'; cap?: Capture }
  | { kind: 'litAlt'; texts: string[]; tt: ('$keyword' | '$punct')[]; cap?: Capture }
  | { kind: 'tok'; name: string; template: boolean; cap?: Capture }
  | { kind: 'node'; rule: string; cap?: Capture }
  | { kind: 'opt'; min1: boolean; body: Step[] }      // min1=true → '+' (first iteration required)
  | { kind: 'many'; body: Step[] }                     // zero-or-more loop after any required first
  | { kind: 'sep'; element: Step[]; delimiter: string; delimTt: '$keyword' | '$punct' }
  | { kind: 'branches'; cap: Capture; branches: { tag: string; steps: Step[]; captures: Capture[] }[] };

interface ArmPlan {
  name: string;
  steps: Step[];
  captures: Capture[];   // flattened, in declaration order
}

const RESERVED = new Set(['arm', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await']);

const PUNCT_NAMES: Record<string, string> = {
  '(': 'paren', ')': 'parenClose', '[': 'bracket', ']': 'bracketClose', '{': 'brace', '}': 'braceClose',
  ';': 'semi', ',': 'comma', ':': 'colon', '.': 'dot', '...': 'spread', '?': 'question', '?.': 'optChain',
  '=': 'eq', '=>': 'arrow', '<': 'lt', '>': 'gt', '*': 'star', '!': 'bang', '#': 'hash', '@': 'at',
  '|': 'pipe', '&': 'amp', '-': 'dash', '+': 'plus', '/': 'slash', '%': 'percent', '~': 'tilde', '^': 'caret',
};

function lowerFirst(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1); }
function sanitizeIdent(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, '_');
  let base = /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
  if (base.startsWith('__')) base = 'f' + base;   // '__' is reserved for the emitted helpers
  return RESERVED.has(base) ? base + '_' : base;
}

const J = (v: unknown) => JSON.stringify(v);

export function generateCstMatch(grammar: CstGrammar, importFrom: string): string {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const templateTokenNames = new Set(grammar.tokens.filter(t => t.template).map(t => t.name));
  const ruleNames = new Set(grammar.rules.map(r => r.name));
  // Int worlds, replicated from emit-parser's symtab (same deterministic derivation
  // from the grammar; any drift is caught instantly by cst-match-totality):
  //   token TYPE kinds — '' punct = 1, $template spans = 2/3/4, named tokens from 5
  //   rule ids — declaration order; the synthetic '$template' node = rules.length
  const typeKind = new Map<string, number>([['', 1], ['$templateHead', 2], ['$templateMiddle', 3], ['$templateTail', 4]]);
  { let next = 5; for (const t of grammar.tokens) if (!typeKind.has(t.name)) typeKind.set(t.name, next++); }
  const ruleId = new Map<string, number>(grammar.rules.map((r, i) => [r.name, i]));
  ruleId.set('$template', grammar.rules.length);
  

  // Pratt / leftRec classification (mirrors the engines' classifyAlts/classifyLeftRec:
  // a rule is op-bearing if any alt contains op/prefix/postfix markers; an alt whose
  // first item is a self-ref is a LED/continuation).
  const ttOf = (text: string): '$keyword' | '$punct' => (isKeywordLiteral(text) ? '$keyword' : '$punct');

  // ── Plan building ──

  function buildArms(rule: RuleDecl): ArmPlan[] {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const self = rule.name;
    const hasOps = alts.some(a => {
      const items = a.type === 'seq' ? a.items : [a];
      return items.some(it => it.type === 'op' || it.type === 'prefix' || it.type === 'postfix');
    });

    const plans: ArmPlan[] = [];
    const armNames = new Set<string>();
    const armName = (base: string): string => {
      let nm = sanitizeIdent(base);
      if (armNames.has(nm)) { let k = 2; while (armNames.has(nm + k)) k++; nm = nm + k; }
      armNames.add(nm);
      return nm;
    };

    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      // Pratt op-form marker alts are covered by the synthesized op arms below.
      if (items.some(it => it.type === 'op' || it.type === 'prefix' || it.type === 'postfix')) continue;

      const isLed = items[0]?.type === 'ref' && items[0].name === self;
      const used = new Set<string>();
      const captures: Capture[] = [];
      const steps: Step[] = [];
      if (isLed) {
        steps.push({ kind: 'node', rule: self, cap: addCap(captures, used, 'left', nodeType(self), 'one') });
        for (const it of items.slice(1)) pushSteps(steps, it, captures, used, 'one');
      } else {
        for (const it of items) pushSteps(steps, it, captures, used, 'one');
      }
      plans.push({ name: armName(deriveArmName(items, isLed)), steps, captures });
    }

    if (hasOps) {
      // Synthesized pratt operator forms (matching parsePratt's构造): op text via src.
      plans.push(opPlan(armName('binaryOp'), [
        selfCap('left'), opLeafCap('op'), selfCap('right'),
      ], self));
      plans.push(opPlan(armName('prefixOp'), [opLeafCap('op'), selfCap('operand')], self));
      plans.push(opPlan(armName('postfixOp'), [selfCap('operand'), opLeafCap('op')], self));
    }
    return plans;

    function selfCap(nm: string): Step {
      return { kind: 'node', rule: self, cap: { name: nm, field: nm, tsType: nodeType(self), card: 'one' } };
    }
    function opLeafCap(nm: string): Step {
      return { kind: 'tok', name: '$operator', template: false, cap: { name: nm, field: nm, tsType: 'LeafEntry', card: 'one' } };
    }
    function opPlan(name: string, steps: Step[], _self: string): ArmPlan {
      const captures = steps.map(s => (s as { cap: Capture }).cap);
      return { name, steps, captures };
    }
  }

  function addCap(captures: Capture[], used: Set<string>, base: string, tsType: string, card: Card): Capture {
    let nm = sanitizeIdent(base);
    if (used.has(nm)) { let k = 2; while (used.has(nm + k)) k++; nm = nm + k; }
    used.add(nm);
    const cap = { name: nm, field: nm, tsType, card };
    captures.push(cap);
    return cap;
  }

  function nodeType(rule: string): string {
    return `NodeEntry<${J(rule)}>`;
  }

  // Name an arm from its first significant item; `sig` is already self-stripped for leds.
  function deriveArmName(items: RuleExpr[], isLed: boolean): string {
    const sig = isLed ? items.slice(1) : items;
    return (isLed ? 'led_' : '') + nameFrom(sig, 8);
  }
  function nameFrom(items: RuleExpr[], fuel: number): string {
    const first = items[0];
    if (!first || fuel <= 0) return 'empty';
    if (first.type === 'literal') {
      const v = first.value;
      return isKeywordLiteral(v) ? v : (PUNCT_NAMES[v] ?? 'p' + [...v].map(c => c.charCodeAt(0)).join('_'));
    }
    if (first.type === 'ref') return lowerFirst(first.name);
    if (first.type === 'not' || first.type === 'sameLine' || first.type === 'adjacent' || first.type === 'noCommentBefore' || first.type === 'noMultilineFlowBefore') {
      return nameFrom(items.slice(1), fuel - 1);   // zero-width: name by what follows
    }
    if (first.type === 'alt') {
      const lits = first.items.filter((x): x is Extract<RuleExpr, { type: 'literal' }> => x.type === 'literal');
      if (lits.length === first.items.length && lits.length > 0) return sanitizeIdent(lits[0].value);
      return nameFrom([first.items[0], ...items.slice(1)], fuel - 1);
    }
    if (first.type === 'quantifier' || first.type === 'group') return nameFrom([first.body, ...items.slice(1)], fuel - 1);
    if (first.type === 'sep') return lowerFirst(first.element.type === 'ref' ? first.element.name : 'list');
    return first.type;
  }

  // Translate one RuleExpr item into steps. `card` is the cardinality CONTEXT
  // (inside opt → 'opt', inside many/sep → 'many') applied to captures.
  function pushSteps(steps: Step[], it: RuleExpr, captures: Capture[], used: Set<string>, card: Card): void {
    switch (it.type) {
      case 'not': case 'sameLine': case 'adjacent': case 'noCommentBefore': case 'noMultilineFlowBefore':
        return;   // zero-width: no children
      case 'literal':
        steps.push({ kind: 'lit', text: it.value, tt: ttOf(it.value) });
        return;
      case 'ref': {
        if (tokenNames.has(it.name)) {
          steps.push({
            kind: 'tok', name: it.name, template: templateTokenNames.has(it.name),
            cap: addCap(captures, used, lowerFirst(it.name), templateTokenNames.has(it.name) ? `LeafEntry | NodeEntry<'$template'>` : 'LeafEntry', card),
          });
        } else {
          steps.push({ kind: 'node', rule: it.name, cap: addCap(captures, used, lowerFirst(it.name), nodeType(it.name), card) });
        }
        return;
      }
      case 'group':
        pushSteps(steps, it.body, captures, used, card);
        return;
      case 'quantifier': {
        const inner: Step[] = [];
        const innerCard: Card = it.kind === '?' ? (card === 'many' ? 'many' : 'opt') : 'many';
        pushSteps(inner, it.body, captures, used, innerCard);
        // A $keyword literal LEADING an optional group marks the group's presence and
        // carries its position (the 'catch'/'else'/'finally' anchors consumers need) —
        // capture it as <kw>Tok.
        const lead = inner[0];
        if (it.kind === '?' && lead !== undefined && lead.kind === 'lit' && lead.tt === '$keyword' && lead.cap === undefined) {
          lead.cap = addCap(captures, used, lead.text + 'Tok', 'LeafEntry', innerCard);
        }
        if (it.kind === '?') steps.push({ kind: 'opt', min1: false, body: inner });
        else if (it.kind === '*') steps.push({ kind: 'many', body: inner });
        else { // '+'
          steps.push({ kind: 'opt', min1: true, body: inner });
          // re-walk for the loop part is unnecessary: emit as required-first + many
          steps.push({ kind: 'many', body: cloneSteps(inner) });
        }
        return;
      }
      case 'seq':
        for (const sub of it.items) pushSteps(steps, sub, captures, used, card);
        return;
      case 'alt': {
        // Pure literal alternation → one capturing step (the matched text is the datum).
        const lits = it.items.filter((x): x is Extract<RuleExpr, { type: 'literal' }> => x.type === 'literal');
        if (lits.length === it.items.length && lits.length > 0) {
          const texts = lits.map(l => l.value);
          const ts = texts.map(t => J(t)).join(' | ');
          steps.push({
            kind: 'litAlt', texts, tt: texts.map(ttOf),
            cap: addCap(captures, used, sanitizeIdent(texts[0]) + 'Kw', ts, card),
          });
          return;
        }
        // Structural alternation: ordered branches, each a tagged mini-plan with its
        // OWN captures — the parent gets ONE field holding a per-branch sub-union
        // ({ branch: 'eq', expr } | { branch: 'empty' } | …), so consumers switch on
        // m.field.branch instead of probing flattened optionals.
        const tagSet = new Set<string>();
        const branches: { tag: string; steps: Step[]; captures: Capture[] }[] = [];
        for (const b of it.items) {
          const bs: Step[] = [];
          const bCaps: Capture[] = [];
          const bUsed = new Set<string>();
          pushSteps(bs, b, bCaps, bUsed, 'one');
          let tag = bs.length === 0 ? 'empty' : sanitizeIdent(nameFrom(b.type === 'seq' ? b.items : [b], 8));
          if (tagSet.has(tag)) { let k = 2; while (tagSet.has(tag + k)) k++; tag = tag + k; }
          tagSet.add(tag);
          branches.push({ tag, steps: bs, captures: bCaps });
        }
        const unionTs = branches.map(b => {
          const fields = b.captures.map(cp => `${cp.field}${cp.card === 'opt' ? '?' : ''}: ${cp.card === 'many' ? `(${cp.tsType})[]` : cp.tsType}`);
          return `{ branch: ${J(b.tag)}${fields.length ? '; ' + fields.join('; ') : ''} }`;
        }).join(' | ');
        const cap = addCap(captures, used, 'alt', unionTs, card);
        steps.push({ kind: 'branches', cap, branches });
        return;
      }
      case 'sep': {
        const el: Step[] = [];
        pushSteps(el, it.element, captures, used, 'many');
        steps.push({ kind: 'sep', element: el, delimiter: it.delimiter, delimTt: ttOf(it.delimiter) });
        return;
      }
      default:
        // op/prefix/postfix never reach here (op-form alts are filtered before).
        throw new Error(`gen-cst-match: unexpected item ${it.type}`);
    }
  }

  function cloneSteps(steps: Step[]): Step[] {
    return steps.map(s => {
      switch (s.kind) {
        case 'opt': return { ...s, body: cloneSteps(s.body) };
        case 'many': return { ...s, body: cloneSteps(s.body) };
        case 'sep': return { ...s, element: cloneSteps(s.element) };
        case 'branches': return { ...s, branches: s.branches.map(b => ({ ...b, steps: cloneSteps(b.steps) })) };
        default: return s;
      }
    });
  }

  // ── Code rendering ──

  const out: string[] = [];
  const emit = (s = '') => out.push(s);
  let tmpId = 0;
  const tmp = () => `_t${tmpId++}`;

  function renderArmFn(rule: RuleDecl, plan: ArmPlan): string {
    const fn = `_${sanitizeIdent(rule.name)}$${plan.name}`;
    tmpId = 0;
    const body: string[] = [];
    const w = (line: string) => body.push(line);
    // capture slots
    for (const c of plan.captures) {
      if (c.card === 'many') w(`  const ${c.name}: (${c.tsType})[] = [];`);
      else w(`  let ${c.name}: (${c.tsType}) | undefined;`);
    }
    w(`  let i = 0;`);
    renderSteps(plan.steps, w, '  ', () => `return null;`);
    w(`  if (i !== cc) return null;`);
    const fields = plan.captures.map(c => {
      if (c.card === 'one') return `${c.field}: ${c.name}!`;
      return c.field === c.name ? c.name : `${c.field}: ${c.name}`;
    });
    w(`  return { arm: ${J(plan.name)}${fields.length ? ', ' + fields.join(', ') : ''} };`);
    emit(`function ${fn}(t: TreeAccess, n: number, cc: number, tb: number, src: string): ${matchTypeName(rule.name)} | null {`);
    for (const line of body) emit(line);
    emit(`}`);
    return fn;
  }

  // Render steps; `onFail(line)` returns the failure statement for this context.
  function renderSteps(steps: Step[], w: (s: string) => void, ind: string, fail: () => string): void {
    for (const st of steps) renderStep(st, w, ind, fail);
  }

  function litCond(text: string, tt: string): string {
    return `__lit(t, cc, tb, i, src, ${J(text)}, ${tt === '$keyword' ? 1 : 0})`;
  }

  function renderStep(st: Step, w: (s: string) => void, ind: string, fail: () => string): void {
    switch (st.kind) {
      case 'lit':
        w(`${ind}if (!${litCond(st.text, st.tt)}) ${fail()}`);
        if (st.cap) assign(st.cap, `__SC[i] as LeafEntry`, w, ind);
        w(`${ind}i++;`);
        return;
      case 'litAlt': {
        const conds = st.texts.map((t, k) => litCond(t, st.tt[k]));
        w(`${ind}if (!(${conds.join(' || ')})) ${fail()}`);
        if (st.cap) assign(st.cap, `src.slice(t.leafOffsetOf(__SC[i], tb), t.leafEndOf(__SC[i], tb)) as ${st.cap.tsType}`, w, ind);
        w(`${ind}i++;`);
        return;
      }
      case 'tok': {
        const cond = st.name === '$operator'
          ? `__opTok(t, cc, i)`
          : st.template
            ? `__tok(t, cc, tb, i, ${typeKind.get(st.name)}) || __nodeOf(t, cc, i, ${ruleId.get('$template')})`
            : `__tok(t, cc, tb, i, ${typeKind.get(st.name)})`;
        w(`${ind}if (!(${cond})) ${fail()}`);
        if (st.cap) assign(st.cap, `__SC[i] as ${st.cap.tsType}`, w, ind);
        w(`${ind}i++;`);
        return;
      }
      case 'node':
        w(`${ind}if (!__nodeOf(t, cc, i, ${ruleId.get(st.rule)})) ${fail()}`);
        if (st.cap) assign(st.cap, `__SC[i] as ${st.cap.tsType}`, w, ind);
        w(`${ind}i++;`);
        return;
      case 'opt': {
        const save = tmp();
        const ok = tmp();
        const lbl = tmp().replace('_t', '_b');
        w(`${ind}{`);
        w(`${ind}  const ${save} = i; let ${ok} = true;`);
        w(`${ind}  ${lbl}: {`);
        renderSteps(st.body, w, ind + '    ', () => `{ ${ok} = false; break ${lbl}; }`);
        w(`${ind}  }`);
        if (st.min1) w(`${ind}  if (!${ok}) ${fail()}`);
        else w(`${ind}  if (!${ok}) i = ${save};`);
        w(`${ind}}`);
        return;
      }
      case 'many': {
        const save = tmp();
        const ok = tmp();
        const lbl = tmp().replace('_t', '_b');
        w(`${ind}for (;;) {`);
        w(`${ind}  const ${save} = i; let ${ok} = true;`);
        w(`${ind}  ${lbl}: {`);
        renderSteps(st.body, w, ind + '    ', () => `{ ${ok} = false; break ${lbl}; }`);
        w(`${ind}  }`);
        w(`${ind}  if (!${ok}) { i = ${save}; break; }`);
        w(`${ind}  if (i === ${save}) break;`);  // zero-width body guard
        w(`${ind}}`);
        return;
      }
      case 'sep': {
        // element (delim element)* with the parser's trailing-delimiter tolerance:
        // a consumed delimiter whose following element fails STAYS consumed.
        const save = tmp();
        const ok = tmp();
        const lbl = tmp().replace('_t', '_b');
        const ok0 = tmp();
        const lbl0 = tmp().replace('_t', '_b');
        w(`${ind}{`);
        w(`${ind}  const ${save} = i; let ${ok0} = true;`);
        w(`${ind}  ${lbl0}: {`);
        renderSteps(st.element, w, ind + '    ', () => `{ ${ok0} = false; break ${lbl0}; }`);
        w(`${ind}  }`);
        w(`${ind}  if (!${ok0}) { i = ${save}; }`);
        w(`${ind}  else for (;;) {`);
        w(`${ind}    if (!${litCond(st.delimiter, st.delimTt)}) break;`);
        w(`${ind}    i++;`);
        w(`${ind}    const ${save}2 = i; let ${ok} = true;`);
        w(`${ind}    ${lbl}: {`);
        renderSteps(st.element, w, ind + '      ', () => `{ ${ok} = false; break ${lbl}; }`);
        w(`${ind}    }`);
        w(`${ind}    if (!${ok}) { i = ${save}2; break; }`);
        w(`${ind}  }`);
        w(`${ind}}`);
        return;
      }
      case 'branches': {
        const done = tmp();
        w(`${ind}{`);
        w(`${ind}  let ${done} = false;`);
        for (const b of st.branches) {
          if (b.steps.length === 0) {
            w(`${ind}  if (!${done}) { ${done} = true; ${assignExpr(st.cap, `{ branch: ${J(b.tag)} }`)} }`);
            continue;
          }
          const save = tmp();
          const ok = tmp();
          const lbl = tmp().replace('_t', '_b');
          // branch-local capture temps, prefixed to avoid cross-branch collisions
          const pfx = tmp() + '_';
          const renamed = b.captures.map(cp => ({ ...cp, name: pfx + cp.name }));
          w(`${ind}  if (!${done}) {`);
          for (const cp of renamed) {
            if (cp.card === 'many') w(`${ind}    const ${cp.name}: (${cp.tsType})[] = [];`);
            else w(`${ind}    let ${cp.name}: (${cp.tsType}) | undefined;`);
          }
          w(`${ind}    const ${save} = i; let ${ok} = true;`);
          w(`${ind}    ${lbl}: {`);
          renderSteps(renameCaps(b.steps, pfx), w, ind + '      ', () => `{ ${ok} = false; break ${lbl}; }`);
          w(`${ind}    }`);
          const fields = renamed.map(cp => `${cp.field}: ${cp.name}${cp.card === 'one' ? '!' : ''}`);
          w(`${ind}    if (${ok}) { ${done} = true; ${assignExpr(st.cap, `{ branch: ${J(b.tag)}${fields.length ? ', ' + fields.join(', ') : ''} }`)} }`);
          w(`${ind}    else i = ${save};`);
          w(`${ind}  }`);
        }
        w(`${ind}  if (!${done}) ${fail()}`);
        w(`${ind}}`);
        return;
      }
    }
  }

  function assign(cap: Capture, expr: string, w: (s: string) => void, ind: string): void {
    if (cap.card === 'many') w(`${ind}${cap.name}.push(${expr});`);
    else w(`${ind}${cap.name} = ${expr};`);
  }
  function assignExpr(cap: Capture, expr: string): string {
    return cap.card === 'many' ? `${cap.name}.push(${expr} as never);` : `${cap.name} = (${expr}) as typeof ${cap.name};`;
  }
  // Re-point a branch's steps at the prefixed temp captures (shallow per-step clone).
  function renameCaps(steps: Step[], pfx: string): Step[] {
    const re = (cp: Capture | undefined): Capture | undefined => (cp ? { ...cp, name: pfx + cp.name } : undefined);
    return steps.map(st => {
      switch (st.kind) {
        case 'lit': case 'litAlt': case 'tok': case 'node': return { ...st, cap: re(st.cap) } as Step;
        case 'opt': return { ...st, body: renameCaps(st.body, pfx) };
        case 'many': return { ...st, body: renameCaps(st.body, pfx) };
        case 'sep': return { ...st, element: renameCaps(st.element, pfx) };
        case 'branches': return { ...st, cap: re(st.cap)!, branches: st.branches.map(b => ({ ...b, steps: renameCaps(b.steps, pfx), captures: b.captures.map(cp => ({ ...cp, name: pfx + cp.name })) })) };
      }
    });
  }

  function matchTypeName(rule: string): string { return `${sanitizeIdent(rule)}Match`; }

  // ── Dispatcher v2: first-child admission keys per arm ──
  // Keys: 'n:<rule>' (node child), 't:<tokenType>' (leaf child by name, incl $operator),
  // 'c:<charCode>' (a $keyword/$punct literal's first char). The dispatcher buckets are
  // SUPERSET filters — the arm unifiers re-check exactly — so over-admission is safe;
  // an arm may appear in many buckets, and bucket-internal order = declaration order
  // (the tie semantics the totality proof relies on).
  function firstAdmit(steps: Step[]): { keys: Set<string>; canEmpty: boolean } {
    const keys = new Set<string>();
    for (const st of steps) {
      switch (st.kind) {
        case 'lit':
          keys.add('c:' + st.text.charCodeAt(0));
          return { keys, canEmpty: false };
        case 'litAlt':
          for (const t of st.texts) keys.add('c:' + t.charCodeAt(0));
          return { keys, canEmpty: false };
        case 'tok':
          keys.add('t:' + st.name);
          if (st.template) keys.add('n:$template');
          return { keys, canEmpty: false };
        case 'node':
          keys.add('n:' + st.rule);
          return { keys, canEmpty: false };
        case 'opt': {
          const a = firstAdmit(st.body);
          for (const k of a.keys) keys.add(k);
          if (st.min1 && !a.canEmpty) return { keys, canEmpty: false };
          continue;
        }
        case 'many': {
          const a = firstAdmit(st.body);
          for (const k of a.keys) keys.add(k);
          continue;
        }
        case 'sep': {
          const a = firstAdmit(st.element);
          for (const k of a.keys) keys.add(k);
          continue;
        }
        case 'branches': {
          let anyEmpty = false;
          for (const b of st.branches) {
            const a = firstAdmit(b.steps);
            for (const k of a.keys) keys.add(k);
            if (a.canEmpty || b.steps.length === 0) anyEmpty = true;
          }
          if (!anyEmpty) return { keys, canEmpty: false };
          continue;
        }
      }
    }
    return { keys, canEmpty: true };
  }

  // ── Drive ──

  const header: string[] = [];
  const bodyParts: string[] = [];
  const matcherMapEntries: string[] = [];

  for (const rule of grammar.rules) {
    const plans = buildArms(rule);
    const tName = matchTypeName(rule.name);
    const nName = nodeType(rule.name);
    // Result union type
    const unionMembers = plans.map(p => {
      const fields = p.captures.map(c => {
        const t = c.card === 'many' ? `(${c.tsType})[]` : c.tsType;
        return `${c.field}${c.card === 'opt' ? '?' : ''}: ${t}`;
      });
      return `{ arm: ${J(p.name)}${fields.length ? '; ' + fields.join('; ') : ''} }`;
    });
    bodyParts.push(`export type ${tName} =\n${unionMembers.map(m => `  | ${m}`).join('\n')};`);
    const fns = plans.map(p => {
      const lines: string[] = [];
      const prevEmit = out.length;
      const fn = renderArmFn(rule, p);
      lines.push(...out.splice(prevEmit));
      bodyParts.push(lines.join('\n'));
      return fn;
    });
    // Dispatcher v2: bucket arms by their first-child admission keys. Nullable-first
    // ("always") arms appear in every bucket at their declaration position; the buckets
    // are superset filters (each arm fn re-checks exactly).
    const admits = plans.map(p => firstAdmit(p.steps));
    const tryLine = (k: number) => `    { const m = ${fns[k]}(t, n, cc, tb, src); if (m !== null) return m; }`;
    const bucketLines = (pred: (keys: Set<string>) => boolean): string[] =>
      plans.map((_, k) => (admits[k].keys.size === 0 || pred(admits[k].keys) ? tryLine(k) : ''))
        .filter(Boolean);
    // (an arm with NO concrete first key — pure-nullable — admits everything)
    const alwaysIdx = plans.map((_, k) => k).filter(k => admits[k].keys.size === 0);

    const nodeRules = new Set<string>();
    const tokNames = new Set<string>();
    const charCodes = new Set<number>();
    for (const a of admits) {
      for (const key of a.keys) {
        if (key.startsWith('n:')) nodeRules.add(key.slice(2));
        else if (key.startsWith('t:')) tokNames.add(key.slice(2));
        else charCodes.add(Number(key.slice(2)));
      }
    }

    // Second-level sub-dispatch for a big node-rule bucket: every concrete member
    // consumed exactly one step (the node), so bucket the rest by position 1's keys
    // read from c[1]. Always-arms ride along in every sub-bucket; the sub-buckets are
    // superset filters like everything else here.
    const subDispatch = (memberIdx: number[], pad: string): string[] => {
      const lines: string[] = [];
      const restAdmit = memberIdx.map(k => {
        if (admits[k].keys.size === 0) return null;            // always-arm: in every sub-bucket
        return firstAdmit(plans[k].steps.slice(1));
      });
      const subTry = (pred: (i: number) => boolean): string[] =>
        memberIdx.map((k, i) => (restAdmit[i] === null || pred(i) ? pad + tryLine(k).trim() : '')).filter(Boolean);
      const nset = new Set<string>(); const tset = new Set<string>(); const cset = new Set<number>();
      for (const a of restAdmit) {
        if (a === null) continue;
        for (const key of a.keys) {
          if (key.startsWith('n:')) nset.add(key.slice(2));
          else if (key.startsWith('t:')) tset.add(key.slice(2));
          else cset.add(Number(key.slice(2)));
        }
      }
      lines.push(`${pad}if (cc < 2) {`);
      lines.push(...memberIdx.map((k, i) => (restAdmit[i] === null || restAdmit[i]!.canEmpty ? pad + '  ' + tryLine(k).trim() : '')).filter(Boolean));
      lines.push(`${pad}} else if ((e1 = __SC[1]) >= 0) {`);
      lines.push(`${pad}  switch (t.ruleIdOf(e1)) {`);
      for (const r of [...nset].sort()) {
        lines.push(`${pad}    case ${ruleId.get(r)}: { // ${r}`);
        lines.push(...subTry(i => restAdmit[i]!.keys.has('n:' + r)).map(l => '    ' + l));
        lines.push(`${pad}      break;`);
        lines.push(`${pad}    }`);
      }
      lines.push(`${pad}    default: {`);
      lines.push(...subTry(() => false).map(l => '    ' + l));
      lines.push(`${pad}      break;`);
      lines.push(`${pad}    }`);
      lines.push(`${pad}  }`);
      lines.push(`${pad}} else if ((_k1 = t.leafKindOf(e1)) === 1 || (_k1 === 0 && t.leafTokKindOf(e1, tb) === 1)) {`);
      lines.push(`${pad}  switch (src.charCodeAt(t.leafOffsetOf(e1, tb))) {`);
      for (const cc of [...cset].sort((a, b) => a - b)) {
        lines.push(`${pad}    case ${cc}: {`);
        lines.push(...subTry(i => restAdmit[i]!.keys.has('c:' + cc)).map(l => '    ' + l));
        lines.push(`${pad}      break;`);
        lines.push(`${pad}    }`);
      }
      lines.push(`${pad}    default: {`);
      lines.push(...subTry(() => false).map(l => '    ' + l));
      lines.push(`${pad}      break;`);
      lines.push(`${pad}    }`);
      lines.push(`${pad}  }`);
      lines.push(`${pad}} else if (_k1 === 2) {`);
      lines.push(...subTry(i => restAdmit[i]!.keys.has('t:$operator')));
      lines.push(`${pad}} else {`);
      lines.push(`${pad}  switch (t.leafTokKindOf(e1, tb)) {`);
      for (const t of [...tset].sort()) {
        if (t === '$operator') continue;   // handled by the kind-2 branch above
        lines.push(`${pad}    case ${typeKind.get(t)}: { // ${t}`);
        lines.push(...subTry(i => restAdmit[i]!.keys.has('t:' + t)).map(l => '    ' + l));
        lines.push(`${pad}      break;`);
        lines.push(`${pad}    }`);
      }
      lines.push(`${pad}    default: {`);
      lines.push(...subTry(() => false).map(l => '    ' + l));
      lines.push(`${pad}      break;`);
      lines.push(`${pad}    }`);
      lines.push(`${pad}  }`);
      lines.push(`${pad}}`);
      return lines;
    };

    const disp: string[] = [];
    disp.push(`export function match${sanitizeIdent(rule.name)}(t: TreeAccess, n: NodeEntry<${J(rule.name)}>, tb: number, src: string): ${tName} {`);
    disp.push(`  const cc = __load(t, n);`);
    disp.push(`  let e1 = 0; let _k1 = 0;`);
    disp.push(`  if (cc === 0) {`);
    for (let k = 0; k < plans.length; k++) if (admits[k].canEmpty || admits[k].keys.size === 0) disp.push(tryLine(k));
    disp.push(`  } else { const e0 = __SC[0];`);
    disp.push(`  if (e0 >= 0) {`);
    disp.push(`    switch (t.ruleIdOf(e0)) {`);
    for (const r of [...nodeRules].sort()) {
      disp.push(`      case ${ruleId.get(r)}: { // ${r}`);
      const members = plans.map((_, k) => k).filter(k => admits[k].keys.size === 0 || admits[k].keys.has('n:' + r));
      const concrete = members.filter(k => admits[k].keys.size !== 0);
      const oneStep = concrete.every(k => plans[k].steps[0]?.kind === 'node');
      if (members.length > 4 && oneStep) {
        disp.push(...subDispatch(members, '        '));
      } else {
        for (const l of bucketLines(keys => keys.has('n:' + r))) disp.push('    ' + l);
      }
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    if (alwaysIdx.length) {
      disp.push(`      default: {`);
      for (const k of alwaysIdx) disp.push('    ' + tryLine(k));
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    disp.push(`    }`);
    disp.push(`  } else { const _k0 = t.leafKindOf(e0);`);
    disp.push(`  if (_k0 === 1 || (_k0 === 0 && t.leafTokKindOf(e0, tb) === 1)) {`);
    disp.push(`    switch (src.charCodeAt(t.leafOffsetOf(e0, tb))) {`);
    for (const cc of [...charCodes].sort((a, b) => a - b)) {
      disp.push(`      case ${cc}: {`);
      for (const l of bucketLines(keys => keys.has('c:' + cc))) disp.push('    ' + l);
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    if (alwaysIdx.length) {
      disp.push(`      default: {`);
      for (const k of alwaysIdx) disp.push('    ' + tryLine(k));
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    disp.push(`    }`);
    disp.push(`  } else if (_k0 === 2) {`);
    for (const l of bucketLines(keys => keys.has('t:$operator'))) disp.push(l);
    disp.push(`  } else {`);
    disp.push(`    switch (t.leafTokKindOf(e0, tb)) {`);
    for (const t of [...tokNames].sort()) {
      if (t === '$operator') continue;   // handled by the kind-2 branch above
      disp.push(`      case ${typeKind.get(t)}: { // ${t}`);
      for (const l of bucketLines(keys => keys.has('t:' + t))) disp.push('    ' + l);
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    if (alwaysIdx.length) {
      disp.push(`      default: {`);
      for (const k of alwaysIdx) disp.push('    ' + tryLine(k));
      disp.push(`        break;`);
      disp.push(`      }`);
    }
    disp.push(`    }`);
    disp.push(`  } } }`);
    disp.push(`  throw new Error(${J(`match${sanitizeIdent(rule.name)}: no arm matches`)} + ' @tok' + tb);`);
    disp.push(`}`);
    bodyParts.push(disp.join('\n'));
    matcherMapEntries.push(`  ${J(rule.name)}: match${sanitizeIdent(rule.name)},`);
  }

  header.push(`// GENERATED by src/gen-cst-match.ts — do not edit. Per-arm CST destructurers for ${J(grammar.name ?? '')}.`);
  header.push(`/* eslint-disable */`);
  header.push(``);
  header.push(`// The arena accessor surface the matchers read through (the emitted parser's`);
  header.push(`// \`tree\` export satisfies it). An ENTRY is a node id (>= 0) or a leaf (< 0).`);
  header.push(`export interface TreeAccess {`);
  header.push(`  ruleNameOf(id: number): string;`);
  header.push(`  ruleIdOf(id: number): number;`);
  header.push(`  childCount(id: number): number;`);
  header.push(`  childAt(id: number, i: number): number;`);
  header.push(`  childrenInto(id: number, out: number[]): number;`);
  header.push(`  leafKindOf(entry: number): number;`);
  header.push(`  leafTokKindOf(entry: number, tokBase: number): number;`);
  header.push(`  leafOffsetOf(entry: number, tokBase: number): number;`);
  header.push(`  leafEndOf(entry: number, tokBase: number): number;`);
  header.push(`}`);
  header.push(`// Branded entry aliases — compile-time discrimination over plain numbers.`);
  header.push(`export type NodeEntry<R extends string = string> = number & { readonly __node?: R };`);
  header.push(`export type LeafEntry = number & { readonly __leaf?: true };`);
  header.push(``);
  header.push(`// Per-call child-entry scratch: matchers are non-reentrant (one node at a time),`);
  header.push(`// so one bulk load replaces a childAt round-trip per probe.`);
  header.push(`const __SC: number[] = [];`);
  header.push(`const __load = (t: TreeAccess, n: number): number => t.childrenInto(n, __SC);`);
  header.push(`// kind: 1 = '$keyword' (leaf kind bit), 0 = '$punct' (type-derived + tok-kind 1).`);
  header.push(`const __lit = (t: TreeAccess, cc: number, tb: number, i: number, src: string, text: string, kind: number): boolean => {`);
  header.push(`  if (i >= cc) return false;`);
  header.push(`  const e = __SC[i];`);
  header.push(`  if (e >= 0 || t.leafKindOf(e) !== kind || (kind === 0 && t.leafTokKindOf(e, tb) !== 1)) return false;`);
  header.push(`  const off = t.leafOffsetOf(e, tb);`);
  header.push(`  return t.leafEndOf(e, tb) - off === text.length && src.startsWith(text, off);`);
  header.push(`};`);
  header.push(`const __tok = (t: TreeAccess, cc: number, tb: number, i: number, k: number): boolean => {`);
  header.push(`  if (i >= cc) return false;`);
  header.push(`  const e = __SC[i];`);
  header.push(`  return e < 0 && t.leafKindOf(e) === 0 && t.leafTokKindOf(e, tb) === k;`);
  header.push(`};`);
  header.push(`const __opTok = (t: TreeAccess, cc: number, i: number): boolean => {`);
  header.push(`  if (i >= cc) return false;`);
  header.push(`  const e = __SC[i];`);
  header.push(`  return e < 0 && t.leafKindOf(e) === 2;`);
  header.push(`};`);
  header.push(`const __nodeOf = (t: TreeAccess, cc: number, i: number, rid: number): boolean => {`);
  header.push(`  if (i >= cc) return false;`);
  header.push(`  const e = __SC[i];`);
  header.push(`  return e >= 0 && t.ruleIdOf(e) === rid;`);
  header.push(`};`);
  header.push(``);

  const footer = [
    ``,
    `/** rule name → its matcher (generic walking; the totality gate uses this). */`,
    `export const MATCHERS: Record<string, (t: TreeAccess, n: never, tb: number, src: string) => { arm: string }> = {`,
    ...matcherMapEntries,
    `};`,
    `/** rule ID → matcher (the emitted parser's rowRule ids — declaration order). */`,
    `export const MATCHERS_BY_ID: ((t: TreeAccess, n: never, tb: number, src: string) => { arm: string })[] = [`,
    ...grammar.rules.map(r => `  match${sanitizeIdent(r.name)},`),
    `];`,
  ];

  return [...header, ...bodyParts.join('\n\n').split('\n'), ...footer].join('\n') + '\n';
}
