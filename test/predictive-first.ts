// Gate: PREDICTIVE LISTS ARE DETERMINISTIC. A list of alternatives the IR flags `predictive` (an rd
// rule's alts, an inline `alt`'s branches, a Pratt rule's NUD sequences) is rendered by every
// portable target as a switch: the first arm whose FIRST signature admits the token is the only one
// tried. That is the longest match only when no token can begin two arms, and when every token an
// arm can begin with is one its signature admits.
//
// The oracle is independent of the signatures and of the lexer plan buildIR reads: the concrete
// alphabet is a symbol per token kind plus a symbol per literal text, the literal's kind being the
// one the interpreter's own lexer (compileTokenizer) gives that text alone; an arm's FIRST over that
// alphabet is computed here from its steps (a zero-width test is taken as passing, so it is a
// superset). For every predictive list of every portable grammar:
//   - the arms' FIRST sets are pairwise disjoint;
//   - each arm's FIRST is inside what its signature admits (a token's literal among the signature's
//     literals, or its kind among the signature's kinds), so the switch reaches the arm.
// The same oracle checks every star / opt / sep BODY GUARD (the step's `guard`: the body is attempted
// only where the next token is in that set): the body cannot match empty, and every token it can
// begin with is in the set, so a refused attempt is one that could not match.
// `@new` is the case that motivated it: the lexer makes it one Decorator token, so TypeScript's
// DecoratorExpr arms `[Decorator, …]` and `['@new', NewTarget, …]` both begin with it.
//
//   node test/predictive-first.ts
import { readdirSync } from 'node:fs';
import { portableIR, type ParserIR, type Step, type FirstSig } from '../src/emit-portable.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import type { CstGrammar } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const paths = [
  ...readdirSync(`${ROOT}test/fixtures`).filter((f) => f.endsWith('.ts') && !f.startsWith('shape-')).map((f) => `${ROOT}test/fixtures/${f}`),
  ...['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].map((g) => `${ROOT}${g}.ts`),
];

let failures = 0, lists = 0, grammars = 0, bodies = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL ${msg}`); };

for (const path of paths) {
  const grammar: CstGrammar = (await import(path)).default;
  let ir: ParserIR;
  try { ir = portableIR(grammar); } catch (e) {
    if (/out of scope|not in scope/.test((e as Error).message)) continue;   // a grammar the portable targets do not take
    throw e;
  }
  grammars++;
  const lex = compileTokenizer(lexSpecOf(grammar));
  // The kind the lexer gives a literal's text on its own (null: not one token of that text).
  const kindMemo = new Map<string, string | null>();
  const kindOf = (lit: string): string | null => {
    if (!kindMemo.has(lit)) {
      let k: string | null = null;
      try { const t = lex(lit); if (t.length === 1 && t[0]!.text === lit) k = t[0]!.type; } catch { /* not lexable alone */ }
      kindMemo.set(lit, k);
    }
    return kindMemo.get(lit)!;
  };
  const lits = new Set<string>();
  const walkLits = (steps: Step[]): void => { for (const s of steps) {
    if (s.t === 'lit') lits.add(s.value); else if (s.t === 'altlit') s.opts.forEach((o) => lits.add(o.value));
    else if (s.t === 'sep') { lits.add(s.delim); walkLits([s.elem]); } else if (s.t === 'star') walkLits([s.step]);
    else if (s.t === 'opt' || s.t === 'seq' || s.t === 'ctx' || s.t === 'suppress') walkLits(s.steps); else if (s.t === 'alt') s.branches.forEach(walkLits);
  } };
  for (const r of ir.rules) {
    if (r.kind === 'rd') r.alts.forEach(walkLits);
    else { r.nudBrackets.forEach((b) => { lits.add(b.first); walkLits(b.steps); }); r.nudSeqs.forEach(walkLits); r.nudCapped.forEach((c) => walkLits(c.steps)); r.prefix.forEach((p) => lits.add(p.op)); }
  }
  const litSym = (l: string) => `'${ir.gtComps.includes(l) ? '>' : l}'`;
  const kindSyms = (k: string): string[] => [`<${k}>`, ...[...lits].filter((l) => kindOf(l) === k).map(litSym), ...(ir.tpl && k === ir.tpl.token ? ['<$templateHead>'] : [])];

  // FIRST over the alphabet, with whether the steps can match nothing.
  type F = { syms: Set<string>; empty: boolean };
  const ruleFirst = new Map<string, F>(ir.rules.map((r) => [r.name, { syms: new Set(), empty: false }]));
  const seqF = (steps: Step[]): F => {
    const syms = new Set<string>();
    for (const s of steps) { const f = stepF(s); f.syms.forEach((x) => syms.add(x)); if (!f.empty) return { syms, empty: false }; }
    return { syms, empty: true };
  };
  const union = (fs: F[]): F => ({ syms: new Set(fs.flatMap((f) => [...f.syms])), empty: fs.some((f) => f.empty) });
  const stepF = (s: Step): F => {
    switch (s.t) {
      case 'lit': return { syms: new Set([litSym(s.value)]), empty: false };
      case 'tok': return { syms: new Set(kindSyms(s.name)), empty: false };
      case 'altlit': return { syms: new Set(s.opts.map((o) => litSym(o.value))), empty: false };
      case 'rule': case 'ruleBp': return ruleFirst.get(s.name)!;
      case 'star': return { syms: stepF(s.step).syms, empty: true };
      case 'opt': return { syms: seqF(s.steps).syms, empty: true };
      case 'sep': return { syms: stepF(s.elem).syms, empty: true };
      case 'alt': return union(s.branches.map(seqF));
      case 'seq': case 'ctx': case 'suppress': return seqF(s.steps);
      case 'look': case 'ahead': case 'aheadCtx': case 'sameLine': return { syms: new Set(), empty: true };
    }
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const r of ir.rules) {
      const f = r.kind === 'rd' ? union(r.alts.map(seqF)) : union([
        ...r.nudToks.map((k): F => ({ syms: new Set(kindSyms(k)), empty: false })),
        ...r.nudBrackets.map((b) => seqF(b.steps)), ...r.nudSeqs.map(seqF), ...r.nudCapped.map((c) => seqF(c.steps)),
        { syms: new Set(r.prefix.map((p) => litSym(p.op))), empty: false },
      ]);
      const old = ruleFirst.get(r.name)!;
      if (f.syms.size !== old.syms.size || f.empty !== old.empty) { ruleFirst.set(r.name, f); changed = true; }
    }
  }
  // What a signature admits: a token whose literal is one of its literals or whose kind is one of its kinds.
  const admits = (sig: NonNullable<FirstSig>, sym: string): boolean => {
    if (sym.startsWith('<')) return sig.toks.includes(sym.slice(1, -1));
    const l = sym.slice(1, -1);
    if (sig.lits.includes(l)) return true;
    const k = kindOf(l);
    return k !== null && sig.toks.includes(k);
  };
  const check = (where: string, arms: Step[][], sigs: FirstSig[]) => {
    lists++;
    const fs = arms.map((a) => seqF(a).syms);
    for (let i = 0; i < arms.length; i++) {
      const sig = sigs[i];
      if (!sig) { fail(`${grammar.name}: ${where} arm ${i} is predictive without a signature`); continue; }
      const missed = [...fs[i]!].filter((x) => !admits(sig, x));
      if (missed.length) fail(`${grammar.name}: ${where} arm ${i} can begin with ${missed.slice(0, 4).join(' ')} which its signature does not admit`);
      for (let j = i + 1; j < arms.length; j++) {
        const both = [...fs[i]!].filter((x) => fs[j]!.has(x));
        if (both.length) fail(`${grammar.name}: ${where} arms ${i} and ${j} both begin with ${both.slice(0, 4).join(' ')}`);
      }
    }
  };
  const checkBody = (where: string, body: Step[], guard: number | undefined) => {
    if (guard === undefined) return;
    bodies++;
    const f = seqF(body), set = ir.tokenSets[guard]!;
    if (f.empty) fail(`${grammar.name}: ${where} has a body guard but its body can match nothing`);
    const missed = [...f.syms].filter((x) => !admits(set, x));
    if (missed.length) fail(`${grammar.name}: ${where} body can begin with ${missed.slice(0, 4).join(' ')} which its guard refuses`);
  };
  const walk = (where: string, steps: Step[]): void => steps.forEach((s, i) => {
    const at = `${where}.${i}`;
    if (s.t === 'star') checkBody(at, [s.step], s.guard); else if (s.t === 'sep') checkBody(at, [s.elem], s.guard); else if (s.t === 'opt') checkBody(at, s.steps, s.guard);
    if (s.t === 'alt') { if (s.predictive) check(`${at} (alt)`, s.branches, s.firsts ?? []); s.branches.forEach((b, j) => walk(`${at}|${j}`, b)); }
    else if (s.t === 'star') walk(at, [s.step]); else if (s.t === 'sep') walk(at, [s.elem]);
    else if (s.t === 'opt' || s.t === 'seq' || s.t === 'ctx' || s.t === 'suppress') walk(at, s.steps);
  });
  for (const r of ir.rules) {
    if (r.kind === 'rd') {
      if (r.predictive && r.alts.length > 1) check(r.name, r.alts, r.altFirst);
      r.alts.forEach((a, i) => walk(`${r.name}/a${i}`, a));
    } else {
      if (r.nudSeqPredictive && r.nudSeqs.length > 1) check(`${r.name} nud sequences`, r.nudSeqs, r.nudSeqs.map(() => null));
      [...r.nudBrackets.map((b) => b.steps), ...r.nudSeqs, ...r.nudCapped.map((c) => c.steps), ...r.leds.map((b) => b.steps)].forEach((a, i) => walk(`${r.name}/${i}`, a));
    }
  }
  ir.lookaheads.forEach((b, i) => walk(`look${i}`, b));
}
console.log(`predictive-first: ${lists} predictive lists and ${bodies} body guards over ${grammars} grammars, ${failures} failures`);
if (failures) process.exit(1);
