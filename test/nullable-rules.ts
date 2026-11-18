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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { computeNullableRules } from '../src/grammar-analysis.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { token, rule, defineGrammar, many, opt, plus, oneOf, range } from '../src/api.ts';
import type { RuleExpr } from '../src/types.ts';

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
  const file = join(tmpdir(), `monogram-nullable-yaml-${process.pid}.ts`);
  writeFileSync(file, emitParser(yaml, jsTarget));
  const em = (await import(file + '?v=' + Date.now())).createParser();
  const eOk = (s: string) => { try { return em.parse(s).errors.length === 0; } catch { return false; } };
  for (const s of accept) check(`yaml accepts ${JSON.stringify(s)} (interpreter + emitted)`, iOk(s) && eOk(s));
  for (const s of reject) check(`yaml rejects ${JSON.stringify(s)} (interpreter + emitted)`, !iOk(s) && !eOk(s));

  // gen-tm's flow detector reads FlowMapEntry's TOP-LEVEL literals (it does not descend into an
  // alt or a ref) for the key/value separator, so the rewrite must keep a top-level `:`.
  const topLits = (e: RuleExpr, out: string[]): string[] => {
    if (e.type === 'literal') out.push(e.value);
    else if (e.type === 'seq') e.items.forEach(x => topLits(x, out));
    else if (e.type === 'quantifier' || e.type === 'group') topLits(e.body, out);
    return out;
  };
  const fme = yaml.rules.find((r: any) => r.name === 'FlowMapEntry');
  check('yaml FlowMapEntry keeps `:` as its first top-level literal (gen-tm flow separator)', topLits(fme.body, [])[0] === ':');
}

console.log(`\n${ok}/${ok + fail} nullable-rule checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
