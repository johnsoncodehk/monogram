// flow-sites.ts — a by-construction gate for the FLOW-INDICATOR-as-block-content class.
//
// Companion to depth-sites.ts. In BLOCK context a flow indicator (`[`/`{`, from indent.flowOpen)
// opens a flow collection ONLY at a node's START; once a node has begun as a plain scalar, a later
// `[`/`{` is plain CONTENT (`a[ b` is the one scalar "a[ b", not "a" + a flow sequence). A flat
// grammar that fires its `#flow-*` region on ANY `[`/`{` mis-scopes the indicator (and can swallow
// the rest of the node). This probe drops each declared flow opener MID plain-scalar across every
// block node context and asserts Monogram keeps it CONTENT (string/name), never a flow open. The
// openers + contexts are DERIVED (indent.flowOpen + the value-position introducers), so the class is
// enumerated, not hand-picked. The official RedCMD grammar is an OPTIONAL oracle (shown when present);
// the pass/fail is self-contained, so this runs in `npm run check`.
//
// Run: node test/flow-sites.ts
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { parse as yamlParse } from 'yaml';
import grammar from '../yaml.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
await loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
function load(files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar('source.yaml');
}
const tm = (await load({ 'source.yaml': 'yaml.tmLanguage.json' }))!;
const SYN = '/tmp/redcmd-yaml/syntaxes';
const official = existsSync(join(SYN, 'yaml.tmLanguage.json')) ? (await load({
  'source.yaml': join(SYN, 'yaml.tmLanguage.json'),
  'source.yaml.1.2': join(SYN, 'yaml-1.2.tmLanguage.json'), 'source.yaml.1.1': join(SYN, 'yaml-1.1.tmLanguage.json'),
  'source.yaml.1.0': join(SYN, 'yaml-1.0.tmLanguage.json'), 'source.yaml.1.3': join(SYN, 'yaml-1.3.tmLanguage.json'),
  'source.yaml.embedded': join(SYN, 'yaml-embedded.tmLanguage.json'),
}))! : null;

interface Tok { start: number; end: number; scopes: string[] }
function innerAt(g: vsctm.IGrammar, text: string, pos: number): string {
  const toks: Tok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = g.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const s = ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
  return (s.length ? s[s.length - 1] : '(none)').replace(/\.yaml$/, '');
}
const valid = (s: string): boolean => { try { yamlParse(s); return true; } catch { return false; } };
// CONTENT = a plain scalar body or a key name — NOT a flow-structure punctuation.
const isContent = (scope: string): boolean => scope.startsWith('string') || scope.startsWith('entity');

// flow openers (declared) × block node-start contexts (document root + each value-position introducer)
const openers: string[] = grammar.indent?.flowOpen ?? [];
const kvSep = grammar.indent?.keyValueSeparator ?? ':';
const contexts: { name: string; prefix: string }[] = [
  { name: 'document root', prefix: '' },
  { name: 'block-mapping value', prefix: `k${kvSep} ` },
  ...(grammar.indent?.compactIndicators ?? []).map(c => ({ name: `compact ${c}`, prefix: `${c} ` })),
];

console.log(`flow openers (declared indent.flowOpen): ${openers.map(o => JSON.stringify(o)).join(', ')}`);
console.log(`legend: a flow indicator MID plain-scalar is CONTENT (string/name), never a flow open\n`);
let cells = 0, wrong = 0, skipped = 0;
const bad: string[] = [];
for (const o of openers) {
  for (const ctx of contexts) {
    const input = `${ctx.prefix}a${o} b`;   // a plain scalar "a<flow> b" — the opener is mid-token
    const focus = ctx.prefix.length + 1;     // the flow opener char (after the leading 'a')
    if (!valid(input)) { skipped++; console.log(`  – skip  [${o} × ${ctx.name}] ${JSON.stringify(input)} (invalid YAML)`); continue; }
    cells++;
    const m = innerAt(tm, input, focus);
    const mOk = isContent(m);
    const oc = official ? innerAt(official, input, focus) : null;
    if (!mOk) { wrong++; bad.push(`${o} × ${ctx.name}`); }
    const tag = mOk ? '✓ ok   ' : (oc !== null && !isContent(oc) ? '~ both ' : '✗ BUG  ');
    console.log(`  ${tag}[${o} × ${ctx.name}]  ${JSON.stringify(input)}  @${focus}«${o}»  M→${m}${oc === null ? '' : `  O→${oc}`}`);
  }
}
console.log(`\n  ${cells} valid cells · ${cells - wrong} ok · ${wrong} mis-fired${official ? '' : '  (Monogram-only — official oracle absent)'} · ${skipped} skipped`);
if (wrong) { console.error(`\n  FLOW-SITE REGRESSION — flow indicator mid-scalar opened a flow region: ${bad.join(' · ')}`); process.exit(1); }
console.log('  ✓ every declared flow opener mid block-scalar stays content — no spurious flow open.');
