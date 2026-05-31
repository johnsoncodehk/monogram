// ─────────────────────────────────────────────────────────────────────────────
//  vue-embed-boundary.ts — the embed BOUNDARY tests (the hard cases the user flagged).
//  An embedded grammar (Monogram's TS) must not consume past the host's structural
//  boundary, even when its own region is open mid-construct.
//
//    #1666 — `type Foo = 123` (no `;`) then `</script>`. The TS `type` body region is
//            open, but `</script>` is HTML's raw-text terminator and MUST end the embed.
//            GENERAL solution = a `begin/while` script region (re-checks per line, drops
//            the region + pops the open TS region at the `</script>` line). GATED here.
//
//    #5012 — `:value="msg as string"`. The closing `"` is an INTRA-LINE boundary; a
//            `while` (line-granularity) can't enforce it, and the embedded TS eats the
//            quote as a string-literal-type. No pure-TM solution — semantic (Volar) only.
//            Documented as a known ceiling, NOT gated.
//
//  Run: node test/vue-embed-boundary.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const read = (p: string) => readFileSync(p, 'utf-8');
const cssStub = JSON.stringify({ scopeName: 'source.css', patterns: [{ match: '[^<]+', name: 'source.css' }] });
const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
  loadGrammar: async (sn) => {
    if (sn === 'text.html.vue') return parseRawGrammar(read('vue.tmLanguage.json'), 'vue.json');
    if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
    if (sn === 'source.ts') return parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');   // Monogram's TS
    if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
    if (sn === 'source.css') return parseRawGrammar(cssStub, 'css.json');
    if (sn === 'vue.injection') return parseRawGrammar(read('vue.injection.tmLanguage.json'), 'inj.json');
    return null;
  },
  getInjections: (sn) => (sn === 'text.html.basic' || sn === 'text.html.vue' ? ['vue.injection'] : undefined),
});
await registry.loadGrammar('vue.injection');
const vue = (await registry.loadGrammar('text.html.vue'))!;

interface Tok { text: string; scopes: string }
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let stack: any = INITIAL;
  for (const line of src.split('\n')) {
    const r = vue.tokenizeLine(line, stack);
    for (const t of r.tokens) { const text = line.slice(t.startIndex, t.endIndex); if (text.trim()) out.push({ text, scopes: t.scopes.join(' ') }); }
    stack = r.ruleStack;
  }
  return out;
}
const find = (toks: Tok[], text: string, pred: (s: string) => boolean) => toks.find(t => t.text === text && pred(t.scopes));

let pass = 0, fail = 0;
function check(label: string, cond: boolean) { if (cond) pass++; else { fail++; console.log(`✗ ${label}`); } }

// ── #1666 (GATED): the embed must END at </script> even with an open trailing type ──
{
  const t = tokenize('<script lang="ts">\ntype Foo = 123\n</script>\n<template><b /></template>');
  check('#1666: the trailing `type Foo = 123` highlights as TS', !!find(t, 'type', s => s.includes('source.ts') && s.includes('storage.type')));
  // the key fix: </script> ends the embed → the following <template> block is NOT swallowed into source.ts
  check('#1666: </script> ends the embed — the following <template> is NOT TS', !t.some(tk => tk.text === 'template' && tk.scopes.includes('source.ts')));
  check('#1666: the <b> in the template is HTML, not TS', !t.some(tk => tk.text === 'b' && tk.scopes.includes('source.ts')));
}

// ── #5012: the inner directive-value embed is the intra-line ceiling (NOT fixed in pure
//    TM — `as string` still eats the closing " WITHIN the block). But begin/while now
//    CONTAINS the damage to the enclosing block — content after </template> survives.
//    We GATE the containment; the inner mis-scope is documented as the ceiling. ──
{
  const t = tokenize('<template>\n  <b :value="msg as string">ok</b>\n</template>\n<script>const z = 1</script>');
  check('#5012: `msg as string` embeds as TS (the value)', !!find(t, 'as', s => s.includes('source.ts')));
  check('#5012 CONTAINMENT: <script> after </template> survives (begin/while bounds the block)', !!find(t, 'const', s => s.includes('source.js') && s.includes('storage.type')));
  const innerCeiling = t.some(tk => tk.text === 'ok' && tk.scopes.includes('source.ts'));
  console.log(`  [intra-line ceiling] #5012 inner value still mis-scopes WITHIN the block = ${innerCeiling} — no pure-TM fix (semantic/Volar). begin/while now contains it to the block (gated above).`);
}

console.log(`\nvue-embed-boundary: ${pass}/${pass + fail} gated checks pass`);
if (fail > 0) { console.log('✗ embed boundary FAILED (expected RED until the begin/while fix lands)'); process.exit(1); }
console.log('✓ embed boundary: </script> ends the embed (#1666); #5012 documented as the TM ceiling');
