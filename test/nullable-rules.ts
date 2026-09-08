// Gate: nullable NON-ENTRY rules are rejected at definition time.
//
// The engine never returns an EMPTY match for a rule: the longest-match loop keeps an
// alternative only when it advanced (`pos > bestPos`), so a rule that can derive the empty
// string has an unreachable empty case, and a reference to it FAILS wherever it would have
// matched nothing. Written as a "filler" rule that is exactly the silent failure mode:
// `Stmt = [Filler, Ident]` with `Filler = rule(() => [[many(NL)]])` rejects a plain `a`.
// `defineGrammar` now names the rule and the fix; `allowNullableRules: true` keeps the
// declaration for a grammar that reaches emptiness through alternatives (YAML).
//
// Run with: node test/nullable-rules.ts
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { computeNullableRules } from '../src/grammar-analysis.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { token, rule, defineGrammar, many, opt, plus, oneOf, range } from '../src/api.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

const WS = token(plus(oneOf(' ', '\t')), { skip: true });
const IDENT = token(plus(oneOf(range('a', 'z'))), { identifier: true });
const NL = token(';', {});   // stands in for a line terminator (a real `\n` is skipped as whitespace here)

function filler(allow: boolean) {
  const Filler = rule(() => [[many(NL)]]);                       // NULLABLE: zero or more terminators
  const Stmt = rule(() => [[Filler, IDENT, opt(',', IDENT)]]);
  const Program = rule(() => [[many(Stmt)]]);                     // the entry may be nullable
  return defineGrammar({ name: 'filler', tokens: { WS, IDENT, NL }, rules: { Filler, Stmt, Program }, entry: Program, ...(allow ? { allowNullableRules: true } : {}) });
}
function inlined() {
  const Stmt = rule(() => [[many(NL), IDENT, opt(',', IDENT)]]);  // the same language, filler inlined
  const Program = rule(() => [[many(Stmt)]]);
  return defineGrammar({ name: 'inlined', tokens: { WS, IDENT, NL }, rules: { Stmt, Program }, entry: Program });
}

// ── 1. defineGrammar rejects the nullable non-entry rule, by name, with the fix ──
let msg = '';
try { filler(false); } catch (e) { msg = (e as Error).message; }
check('a nullable non-entry rule is rejected', msg !== '');
check('the message names the rule', msg.includes("'Filler'"));
check('the message explains the unreachable empty match', /empty match/.test(msg) && /unreachable/.test(msg));
check('the message points at the inline fix', msg.includes('many(X)'));
check('the message points at the opt-out', msg.includes('allowNullableRules'));

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

// ── 3. The opt-out keeps the declaration and changes no parse (the empty case stays unreachable) ──
const gf = filler(true);
check('allowNullableRules keeps the grammar buildable', gf.rules.some(r => r.name === 'Filler'));
check('computeNullableRules still reports it', computeNullableRules(gf).nullableRules.has('Filler'));
const interp = createParser(gf);
const rejects = (s: string) => { try { interp.parse(s); return false; } catch { return true; } };
check('documented behaviour: the filler grammar rejects a plain statement (empty Filler never matches)', rejects('a'));
check('documented behaviour: the same grammar ACCEPTS `;a` (Filler matched non-empty), which is the inconsistency the check exists to surface', !rejects(';a'));
{
  const file = join(tmpdir(), `monogram-nullable-${process.pid}.ts`);
  writeFileSync(file, emitParser(gf, jsTarget));
  const p = (await import(file + '?v=' + Date.now())).createParser();
  check('the emitted engine agrees (total parse reports the statement as unexpected)', p.parse('a').errors.length > 0);
}

// ── 4. The shipped grammars: YAML opts out explicitly; the rest have no nullable non-entry rule ──
for (const [name, entry] of [['typescript', 'Program'], ['javascript', 'Program'], ['html', 'Document'], ['yaml', 'Stream']] as const) {
  let g: any; let loaded = true;
  try { g = (await import(`../${name}.ts`)).default; } catch { loaded = false; }
  check(`${name}.ts still defines`, loaded);
  if (!loaded) continue;
  const nonEntry = [...computeNullableRules(g).nullableRules].filter(n => n !== entry);
  if (name === 'yaml') check('yaml declares its nullable rules deliberately (Node, FlowNode, …)', nonEntry.includes('Node') && nonEntry.includes('FlowNode'));
  else check(`${name} has no nullable non-entry rule`, nonEntry.length === 0);
}

console.log(`\n${ok}/${ok + fail} nullable-rule checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
