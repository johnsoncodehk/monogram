// ─────────────────────────────────────────────────────────────────────────────
//  vue-generic-dropin.ts — proves the DE-HACKED `generic="…"` attribute embed in Monogram's vue
//  grammar tokenizes correctly under BOTH hosts: Monogram's OWN source.ts AND VS Code's OFFICIAL
//  source.ts. The generic= value patterns now use the official PUBLIC repository keys
//  (`source.ts#comment`, `source.ts#type`, `source.ts#punctuation-comma`) + the literal variance /
//  `=` matches — exactly mirroring Volar's hand-written `vue-directives-generic-attr`. That only
//  works if those official key NAMES resolve in whichever source.ts is loaded:
//    • Monogram's source.ts — via typescript.ts's `repoAliases` (the drop-in API).
//    • VS Code's source.ts  — natively (they're its own keys).
//  This harness loads Monogram's vue grammar TWICE — once over each source.ts — and asserts the
//  type parameter, the `extends` constraint keyword, the comma separator, and a `/* */` comment in
//  the value all carry the right scope on BOTH. If they only worked on one host, the dual-key hack
//  was load-bearing; passing on both proves the alias makes Monogram's source.ts a true drop-in.
//
//  Skips (exit 0) if VS Code's official TS grammar isn't installed — dev-only, like vue-dropin.
//  Run: node test/vue-generic-dropin.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const VSC = process.env.MONOGRAM_VSCODE_EXT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const offTs = `${VSC}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`;
if (!existsSync(offTs)) {
  console.log('⊘ Skipped: VS Code official TS grammar not found (set MONOGRAM_VSCODE_EXT). Dev-only, like vue-dropin.');
  process.exit(0);
}

const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
const onigLib = Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) });
const read = (p: string) => readFileSync(p, 'utf-8');
const stub = (sn: string) => parseRawGrammar(JSON.stringify({ scopeName: sn, patterns: [{ match: '[^\\n]+', name: sn }] }), `${sn}.json`);

// A registry hosting Monogram's vue grammar over a CHOSEN source.ts (Monogram's own, or VS Code's).
function makeRegistry(tsPath: string) {
  return new Registry({
    onigLib,
    loadGrammar: async (sn) => {
      if (sn === 'text.html.vue') return parseRawGrammar(read('vue.tmLanguage.json'), 'vue.json');
      if (sn === 'text.html.basic') return parseRawGrammar(read(`${VSC}/html/syntaxes/html.tmLanguage.json`), 'html.json');
      if (sn === 'text.html.derivative') return parseRawGrammar(read(`${VSC}/html/syntaxes/html-derivative.tmLanguage.json`), 'der.json');
      if (sn === 'source.ts') return parseRawGrammar(read(tsPath), 'ts.json');
      if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
      if (sn.startsWith('source.') || sn.startsWith('text.')) return stub(sn);
      return null;
    },
  });
}

// Tokenize `src` through the vue grammar and return offset → joined-scope lookup.
async function lookupFor(tsPath: string, src: string): Promise<(offset: number) => string> {
  const reg = makeRegistry(tsPath);
  const vue = (await reg.loadGrammar('text.html.vue'))!;
  const lines = src.split('\n'); const ls: number[] = []; let a = 0;
  for (const l of lines) { ls.push(a); a += l.length + 1; }
  const lt: any[][] = []; let st: any = INITIAL;
  for (const l of lines) { const r = vue.tokenizeLine(l, st); lt.push(r.tokens); st = r.ruleStack; }
  return (o: number) => { let li = 0; while (li + 1 < ls.length && ls[li + 1] <= o) li++; const c = o - ls[li]; for (const t of lt[li] ?? []) if (c >= t.startIndex && c < t.endIndex) return t.scopes.join(' '); return ''; };
}

// A `<script setup generic="…">` SFC. The value is a TS type-parameter list with: a type parameter
// (`T`), a constraint (`extends`), a referenced type (`Base`), a comma, a second param with a `=`
// default, and a `/* */` comment — every construct the generic= value rule routes through a
// different repository key.
const SRC = [
  '<script setup lang="ts" generic="T extends Base, U = /*c*/ string">',
  'const x = 1',
  '</script>',
].join('\n');

// Probe by the EXACT character offset of a construct in SRC (each construct below is unique in the
// line, so indexOf is unambiguous). We check the scope STACK CONTAINS the expected leaf (not exact
// equality) so incidental wrapper scopes (which differ between the two TS grammars) don't matter —
// what matters is that the generic= value is tokenized AS TYPESCRIPT (the official keys resolved),
// not dropped to a plain string.
const checks: { find: string; want: string; desc: string }[] = [
  { find: 'T extends', want: 'entity.name.type', desc: 'type parameter `T` → entity.name.type' },
  { find: 'extends', want: 'storage.modifier.ts', desc: 'constraint keyword `extends` → storage.modifier.ts (the inlined variance match)' },
  { find: 'Base', want: 'entity.name.type', desc: 'constraint type `Base` → entity.name.type (via source.ts#type)' },
  { find: ', U', want: 'punctuation.separator.comma.ts', desc: 'separator `,` → punctuation.separator.comma.ts (via source.ts#punctuation-comma)' },
  { find: '/*c*/', want: 'comment.block', desc: 'inline `/*c*/` → comment scope (via source.ts#comment)' },
];

let pass = 0; const failures: string[] = [];
for (const [label, tsPath] of [['Monogram source.ts', 'typescript.tmLanguage.json'] as const, ['official source.ts', offTs] as const]) {
  const lk = await lookupFor(tsPath, SRC);
  for (const ch of checks) {
    const got = lk(SRC.indexOf(ch.find));   // offset of the construct's FIRST char (the target token)
    if (got.includes(ch.want)) pass++;
    else failures.push(`  ✗ [${label}] ${ch.desc}\n      at ${JSON.stringify(ch.find)} got: ${got || '(empty)'}`);
  }
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  De-hacked Vue `generic="…"` — dual-host tokenization (Monogram + official source.ts)');
console.log('══════════════════════════════════════════════════════════════════════');
const total = checks.length * 2;
console.log(`  ${pass}/${total} scope checks pass across BOTH hosts (${checks.length} constructs × 2 source.ts hosts)`);
for (const f of failures) console.log(f);
if (failures.length) { console.log('\n✗ generic= does not tokenize identically on both hosts — the official keys do not resolve somewhere.'); process.exit(1); }
console.log('  ✓ generic= uses ONLY official keys (source.ts#comment/#type/#punctuation-comma) +');
console.log('    the literal variance/`=` matches, and lights up correctly on Monogram\'s source.ts');
console.log('    (via repoAliases) AND VS Code\'s official source.ts — a true repository-level drop-in.');
