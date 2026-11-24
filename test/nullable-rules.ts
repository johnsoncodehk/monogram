// Gate: nullable NON-ENTRY rules are rejected at definition time.
//
// The engine never returns an EMPTY match for a rule: the longest-match loop keeps an
// alternative only when it advanced (`pos > bestPos`), so a rule that can derive the empty
// string has an unreachable empty case, and a reference to it FAILS wherever it would have
// matched nothing. Written as a "filler" rule that is exactly the silent failure mode:
// `Stmt = [Filler, Ident]` with `Filler = rule(() => [[many(NL)]])` rejects a plain `a`.
// `defineGrammar` now names the rule and the fix. There is no opt-out: YAML, the one grammar
// that used to declare nullable rules, reaches its empty nodes through `opt(...)` at use sites.
//
// Run with: node test/nullable-rules.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createParser } from '../src/interpreter/interpreter.ts';
import { computeNullableRules } from '../src/grammar/grammar-analysis.ts';
import { emitParser } from '../src/targets/target.ts';
import { jsTarget } from '../src/targets/target-js.ts';
import { tsTarget } from '../src/targets/target-ts.ts';
import { defineShape, shapeCoverage, child, node } from '../src/shape.ts';
import { token, rule, defineGrammar, many, opt, plus, oneOf, range } from '../src/api.ts';
import type { RuleExpr } from '../src/grammar/types.ts';
import { scratchDir } from './scratch.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

const WS = token(plus(oneOf(' ', '\t')), { skip: true });
const IDENT = token(plus(oneOf(range('a', 'z'))), { identifier: true });
const NL = token(';', {});   // stands in for a line terminator (a real `\n` is skipped as whitespace here)

function filler(extra: object = {}) {
  const Filler = rule(() => [[many(NL)]]);                       // NULLABLE: zero or more terminators
  const Stmt = rule(() => [[Filler, IDENT, opt(',', IDENT)]]);
  const Program = rule(() => [[many(Stmt)]]);                     // the entry may be nullable
  return defineGrammar({ name: 'filler', tokens: { WS, IDENT, NL }, rules: { Filler, Stmt, Program }, entry: Program, ...extra });
}
function inlined() {
  const Stmt = rule(() => [[many(NL), IDENT, opt(',', IDENT)]]);  // the same language, filler inlined
  const Program = rule(() => [[many(Stmt)]]);
  return defineGrammar({ name: 'inlined', tokens: { WS, IDENT, NL }, rules: { Stmt, Program }, entry: Program });
}

// ── 1. defineGrammar rejects the nullable non-entry rule, by name, with the fix ──
let msg = '';
try { filler(); } catch (e) { msg = (e as Error).message; }
check('a nullable non-entry rule is rejected', msg !== '');
check('the message names the rule', msg.includes("'Filler'"));
check('the message explains the unreachable empty match', /empty match/.test(msg) && /unreachable/.test(msg));
check('the message points at the inline fix', msg.includes('many(X)'));
check('the message points at the opt() fix', msg.includes('opt(...)'));
check('the message offers no opt-out', !msg.includes('allowNullableRules'));

// ── 2. A nullable ENTRY rule is fine (an empty document is handled by the driver) ──
let entryOk = true;
try { inlined(); } catch { entryOk = false; }
check('a nullable entry rule (Program = many(Stmt)) is accepted', entryOk);
const gi = inlined();
check('the inlined grammar reports no nullable non-entry rule', [...computeNullableRules(gi).nullableRules].filter(n => n !== 'Program').length === 0);
check('the inlined form parses what the filler form silently rejected', (() => { try { return createParser(gi).parse(';;a,b;c').rule === 'Program'; } catch { return false; } })());

// `entry` may be omitted (the LAST rule is then the entry, as findEntryRule resolves it): the
// exemption must follow that rule, and only that rule.
{
  let implicitOk = true;
  try {
    const Stmt = rule(() => [[IDENT]]); const Program = rule(() => [[many(Stmt)]]);
    defineGrammar({ name: 'implicit', tokens: { WS, IDENT, NL }, rules: { Stmt, Program } } as any);
  } catch { implicitOk = false; }
  check('with `entry` omitted, a nullable LAST rule is the implicit entry and is accepted', implicitOk);
  let implicitBad = false;
  try {
    const Filler = rule(() => [[many(NL)]]); const Program = rule(() => [[Filler, IDENT]]);
    defineGrammar({ name: 'implicit2', tokens: { WS, IDENT, NL }, rules: { Filler, Program } } as any);
  } catch { implicitBad = true; }
  check('with `entry` omitted, a nullable non-last rule is still rejected', implicitBad);
}

// A DECLARED `entry` that is not the last rule: every engine starts from it (not from the last
// rule), and the nullable exemption follows it. Before the entry was stored on the grammar, this
// grammar was rejected (nullable `Program` read as a non-entry rule) and, with the exemption
// lifted, parsed from `Item` in every target.
{
  const Program = rule(() => [[many(Item)]]);                     // nullable, declared FIRST
  const Item = rule(() => [[IDENT, opt(',', IDENT)]]);
  let g: any = null;
  try { g = defineGrammar({ name: 'entryfirst', tokens: { WS, IDENT, NL }, rules: { Program, Item }, entry: Program }); } catch { /* checked below */ }
  check('a nullable entry declared before other rules is accepted (the exemption follows `entry`)', g !== null);
  if (g) {
    const src = 'a,b c';   // two Items: only the entry Program derives it
    let iRule = '';
    try { iRule = createParser(g).parse(src).rule; } catch { /* rejected */ }
    check('the interpreter starts from the declared entry', iRule === 'Program');
    const file = join(scratchDir('nullable-rules'), 'entryfirst.ts');
    writeFileSync(file, emitParser(g, tsTarget));
    const m = await import(file + '?v=' + Date.now());
    let pRule: unknown = null;
    try { const r = m.parseWith(src, m.cstBuilder); pRule = r?.rule; } catch { /* rejected */ }
    check('the portable TS parser starts from the declared entry', pRule === 'Program');
    // shapeCoverage reaches rules from the declared entry: mapping only Program's arm reaches Item.
    const cov = shapeCoverage(defineShape(g, { name: 'entryfirst-ast', rules: { Program: { item: node('Program', { items: child('item') }) } } }));
    check('shapeCoverage reports the declared entry', cov.entry === 'Program');
    check('shapeCoverage reaches the rules the entry reads', cov.arms.some((a) => a.rule === 'Item' && a.reached));
  }
}

// ── 3. There is no opt-out: the former `allowNullableRules` key is not honoured ──
let optOutRejected = false;
try { filler({ allowNullableRules: true }); } catch { optOutRejected = true; }
check('a stray `allowNullableRules: true` does not exempt a nullable rule', optOutRejected);

// ── 4. The shipped grammars have no nullable non-entry rule ──
let yaml: any = null;
for (const [name, entry] of [['typescript', 'Program'], ['javascript', 'Program'], ['html', 'Document'], ['yaml', 'Stream']] as const) {
  let g: any; let loaded = true;
  try { g = (await import(`../${name}.ts`)).default; } catch { loaded = false; }
  check(`${name}.ts still defines`, loaded);
  if (!loaded) continue;
  if (name === 'yaml') yaml = g;
  const nonEntry = [...computeNullableRules(g).nullableRules].filter(n => n !== entry);
  check(`${name} has no nullable non-entry rule`, nonEntry.length === 0);
}

// ── 5. YAML: the rules that used to be nullable keep every empty / property-only form ──
// Node, FlowNode and FlowMapEntry were rewritten to require content (FlowSeqEntry and AfterDocEnd
// followed); emptiness now comes from `opt(...)` at the use sites. Interpreter and emitted parser
// must both keep these accept/reject verdicts.
if (yaml) {
  const nullableNow = computeNullableRules(yaml).nullableRules;
  for (const r of ['Node', 'FlowNode', 'FlowMapEntry', 'FlowSeqEntry', 'AfterDocEnd']) check(`yaml ${r} is non-nullable`, !nullableNow.has(r));

  const accept = [
    '&a', '!!str', '!!str &a', '&a !!str', '&a\nfoo', '&s\n- a\n- b', 'a:\n  &x\nb: c', 'key: &anchor\nb: c', '- &x\n- 1', '--- &a\n...',
    '{a:}', '{a:,}', '{a: &x}', '{&x : v}', '[&x]', '[&x, !!str]', '[!!map {a: b}, &q [1]]',
    '{}', '{a: b,}', '{a, b}', '{? a : b, ? c, ?}', '{? foo :,}', '{: v}', '{:}', '{foo\n: bar}',
    '[a: b]', '[]', '[a,]', '...', '...\n--- b', 'key:', '- ', '',
  ];
  const reject = ['&a - x', '!!t &a - x', '&a &b x', '[a,,b]', '[,a]', '{a,,b}', '{: a : b}'];
  const interp = createParser(yaml);
  const iOk = (s: string) => { try { interp.parse(s); return true; } catch { return false; } };
  const file = join(scratchDir('nullable-rules'), 'yaml.ts');
  writeFileSync(file, emitParser(yaml, jsTarget));
  const em = (await import(file + '?v=' + Date.now())).createParser();
  const eOk = (s: string) => { try { return em.parse(s).errors.length === 0; } catch { return false; } };
  for (const s of accept) check(`yaml accepts ${JSON.stringify(s)} (interpreter + emitted)`, iOk(s) && eOk(s));
  for (const s of reject) check(`yaml rejects ${JSON.stringify(s)} (interpreter + emitted)`, !iOk(s) && !eOk(s));

  // gen-textmate's flow detector reads FlowMapEntry's TOP-LEVEL literals (it does not descend into an
  // alt or a ref) for the key/value separator, so the rewrite must keep a top-level `:`.
  const topLits = (e: RuleExpr, out: string[]): string[] => {
    if (e.type === 'literal') out.push(e.value);
    else if (e.type === 'seq') e.items.forEach(x => topLits(x, out));
    else if (e.type === 'quantifier' || e.type === 'group') topLits(e.body, out);
    return out;
  };
  const fme = yaml.rules.find((r: any) => r.name === 'FlowMapEntry');
  check('yaml FlowMapEntry keeps `:` as its first top-level literal (gen-textmate flow separator)', topLits(fme.body, [])[0] === ':');
}

console.log(`\n${ok}/${ok + fail} nullable-rule checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
