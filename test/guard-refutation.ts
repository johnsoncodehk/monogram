// Gate: A GUARD ONLY REFUSES WHAT CANNOT MATCH. Every portable target skips a longest-match
// candidate (an rd rule's alternative, a Pratt NUD sequence or capped arm) when the token at its
// start fails its Guard (emit-portable.ts Guard): outside its `first` set, or failing one of its
// `lead` tests — the candidate's own leading one-token tests (test/guard-lead.ts proves those
// equal), and the refusal by the complement of its FIRST over concrete symbols (emit-portable.ts,
// "Refusal by the complement of FIRST"). A wrong refusal would change the language silently, and
// the interpreter, which takes no such guard, would not notice unless a corpus input happened to
// reach it.
//
// So, per guarded candidate and per symbol of the alphabet its guard refuses, this asks the
// INTERPRETER whether the candidate matches a non-empty prefix of inputs that begin with that
// symbol: a probe rule `[candidate, many(any token)]` per candidate, parsed from a sample token of
// the symbol (the literal's text; for a kind, a text the interpreter's lexer makes one token of
// that kind and no literal) followed by each of a few continuations. Any probe whose candidate part
// consumed a token is a refusal of something that matches: the gate fails. Exhaustive over the
// alphabet at k = 1, bounded over what follows. The probe runs outside every context ([Await] /
// [Yield], no-`in`), so it checks the refusal in the context a top-level parse has.
//
//   node test/guard-refutation.ts
import { readdirSync } from 'node:fs';
import { portableIR, buildLexIdPlan, type ParserIR, type Guard, type TokenSet } from '../src/emit-portable.ts';
import { analyzeGrammar, hasMarker } from '../src/grammar-analysis.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { createParser } from '../src/gen-parser.ts';
import { collectLiterals } from '../src/grammar-utils.ts';
import type { Grammar, RuleExpr, RuleDecl } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const paths = [
  ...readdirSync(`${ROOT}test/fixtures`).filter((f) => f.endsWith('.ts') && !f.startsWith('shape-')).map((f) => `${ROOT}test/fixtures/${f}`),
  ...['javascript', 'typescript'].map((g) => `${ROOT}${g}.ts`),
];
const KIND_SAMPLES = ['zq', 'zq9', '$zq', '_zq', '#zq', '@zq', '1', '0x1', '1n', '"s"', "'s'", '`t`', '/r/'];
const CONTINUATIONS = ['', ' zq', ' ;', ' (', ' )', ' {', ' }', ' 1', ' ,', ' =', ' .', ' zq ;', ' 1 ;', ' zq )', ' ( )', ' { }', ' zq }'];

let failures = 0, probes = 0, refusals = 0;
const t0 = Date.now();
for (const path of paths) {
  const grammar: Grammar = (await import(path)).default;
  let ir: ParserIR;
  try { ir = portableIR(grammar); } catch (e) {
    if (/out of scope|not in scope/.test((e as Error).message)) continue;
    throw e;
  }
  const ids = buildLexIdPlan(ir);
  const lex = compileTokenizer(lexSpecOf(grammar));
  const one = (text: string) => { try { const t = lex(text); return t.length === 1 && t[0]!.text === text ? t[0]! : null; } catch { return null; } };
  // The alphabet: a symbol is a literal (by lid) or a kind with no literal (by kid), each with a sample text.
  type Sym = { name: string; text: string; lid: number; kid: number };
  const alphabet: Sym[] = [];
  ids.lids.forEach((l, lid) => { if (lid > 0 && one(l)) alphabet.push({ name: JSON.stringify(l), text: l, lid, kid: ids.kids.indexOf(one(l)!.type) }); });
  ids.kids.forEach((k, kid) => {
    if (kid === 0) return;
    const text = KIND_SAMPLES.find((s) => { const t = one(s); return t !== null && t.type === k && !ids.lids.includes(s); });
    if (text !== undefined) alphabet.push({ name: `<${k}>`, text, lid: 0, kid });
  });
  const inSet = (s: TokenSet, y: Sym): boolean => (y.lid !== 0 && s.lits.includes(ids.lids[y.lid]!)) || s.toks.includes(ids.kids[y.kid]!);
  // Whether the guard admits a token of symbol y outside every context (where the probe parses).
  const admits = (g: Guard, y: Sym): boolean => g === null || ((g.first === null || inSet(g.first, y)) && g.lead.every((l) => inSet(ir.tokenSets[l.set]!, y) === l.is));

  // The candidates of each longest-match list, with their grammar expressions and guards.
  const a = analyzeGrammar(grammar);
  type Cand = { where: string; guard: Guard; probe: number };
  const lists: Cand[][] = [];
  const exprs: RuleExpr[] = [];
  const cand = (where: string, expr: RuleExpr, guard: Guard): Cand => ({ where, guard, probe: exprs.push(expr) - 1 });
  for (const r of ir.rules) {
    const decl = grammar.rules.find((d) => d.name === r.name)!;
    if (r.kind === 'rd') {
      const items = decl.body.type === 'alt' ? decl.body.items : [decl.body];
      lists.push(items.map((e, i) => cand(`${r.name}/a${i}`, e, r.altGuard[i]!)));
    } else {
      const nuds = a.prattClassified.get(r.name)?.nuds ?? a.leftRecClassified.get(r.name)?.atoms ?? [];
      if (nuds.length !== r.nudOrder.length) { console.log(`  ${grammar.name}: ${r.name}: ${nuds.length} NUD expressions for ${r.nudOrder.length} arms, not probed`); continue; }
      // An arm written with an operator marker (the prefix arm) is not probed; it is never guarded.
      lists.push(r.nudOrder.flatMap((n, i) => (hasMarker(nuds[i]!) ? [] : [cand(`${r.name}#nud${i}`, nuds[i]!,
        n.kind === 'seq' ? r.nudSeqGuard[n.index]! : n.kind === 'capped' ? r.nudCappedGuard[n.index]! : null)])));
    }
  }
  const anyName = '__anyToken';
  const tokenRefs: RuleExpr[] = grammar.tokens.filter((t) => !t.flags.includes('skip') && !(typeof t.pattern !== 'string' && t.pattern.type === 'never')).map((t) => ({ type: 'ref', name: t.name }));
  // The rule literals only: adding an operator-only literal to the rules would change how the
  // grammar's `>`-led operators are lexed (gtComposites).
  const ruleLits = new Set(grammar.rules.flatMap((r) => collectLiterals(r.body)));
  const litRefs: RuleExpr[] = [...ruleLits].map((l) => ({ type: 'literal', value: l }));
  const probeRules: RuleDecl[] = [
    { name: anyName, body: { type: 'alt', items: [...tokenRefs, ...litRefs] }, flags: [] },
    ...exprs.map((e, i): RuleDecl => ({ name: `__probe${i}`, body: { type: 'seq', items: [{ type: 'group', body: e }, { type: 'quantifier', kind: '*', body: { type: 'ref', name: anyName } }] } as RuleExpr, flags: [] })),
  ];
  const parser = createParser({ ...grammar, rules: [...grammar.rules, ...probeRules] });
  // Where a candidate's match of `text` ends (0: it matches nothing there): where the part that
  // takes any token starts (a punctuation leaf may not be kept in the tree, so children are not
  // counted).
  const endOf = (probe: number, text: string): number => {
    let cst;
    try { cst = parser.parse(text, `__probe${probe}`); } catch { return 0; }
    const rest = (cst.children as { rule?: string; offset: number }[]).find((c) => c.rule === anyName);
    return rest ? rest.offset : cst.end;
  };
  let bad = 0, guarded = 0;
  for (const list of lists) list.forEach((c, i) => {
    if (c.guard === null) return;
    guarded++;
    for (const y of alphabet) {
      if (admits(c.guard, y)) continue;
      refusals++;
      for (const w of CONTINUATIONS) {
        probes++;
        const end = endOf(c.probe, y.text + w);
        if (end === 0) continue;
        // A refused candidate that matches is harmless only where it cannot win: an earlier
        // candidate the guards try there ends at least as far (a tie goes to the earlier one) —
        // how sameAsEarlierOutside narrows a candidate that repeats an earlier one.
        if (list.slice(0, i).some((e) => admits(e.guard, y) && endOf(e.probe, y.text + w) >= end)) continue;
        bad++;
        if (bad <= 12) console.log(`  FAIL ${grammar.name}: ${c.where} refuses ${y.name} but matches ${JSON.stringify(y.text + w)}`);
        break;
      }
    }
  });
  failures += bad;
  console.log(`  ${grammar.name}: ${guarded} guarded candidates, alphabet ${alphabet.length}, ${bad} unsound refusals`);
}
console.log(`guard-refutation: ${refusals} refusals probed with ${probes} inputs in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failures} unsound`);
if (failures) process.exit(1);
