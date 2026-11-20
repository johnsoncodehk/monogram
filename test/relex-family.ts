// Gate: the relex / scanMeta family has ONE source (src/relex-family.ts).
//
//   1. every portable target's output embeds the family exactly as printed from that source
//      (adapters cannot patch or re-decide it per target);
//   2. each family function is defined exactly once per output (no hand-written duplicate
//      or per-mode variant left beside it), and stateful modes define no stateless toMeta;
//   3. the fixtures below cover every lexer mode the family specializes for — the behavioral
//      edit ≡ fresh / streamEq / oracle-alignment checks for them live in portable-targets.
//
//   node test/relex-family.ts
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { portableIR } from '../src/emit-portable.ts';
import { emitRelexFamily, relexFamilyFns, relexMode, type RelexMode } from '../src/relex-family.ts';
import type { PortableTarget } from '../src/define-target.ts';

const FIXTURES: Array<{ path: string; mode: string }> = [
  { path: './fixtures/calc.ts', mode: 'plain' },
  { path: './fixtures/envspec.ts', mode: 'newline' },
  { path: './fixtures/regexjs.ts', mode: 'regex' },
  { path: './fixtures/templatejs.ts', mode: 'template' },
  { path: '../javascript.ts', mode: 'regex+template' },
  { path: './fixtures/envtpl.ts', mode: 'full-relex' },
];

const modeName = (m: RelexMode): string => {
  if (!m.window) return 'full-relex';
  const parts = [m.newline && 'newline', m.regex && 'regex', m.template && 'template'].filter(Boolean);
  return parts.length ? parts.join('+') : 'plain';
};

const HOSTS: Array<{ host: string; target: PortableTarget; def: (name: string) => RegExp }> = [
  { host: 'ts', target: tsTarget, def: (n) => new RegExp(`^(function ${n}\\(|const ${n} =)`, 'gm') },
  { host: 'go', target: goTarget, def: (n) => new RegExp(`^func ${n}\\(`, 'gm') },
  { host: 'rust', target: rustTarget, def: (n) => new RegExp(`^fn ${n.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}\\(`, 'gm') },
];

const FAMILY_NAMES = ['toMeta', 'scanMetaToks', 'scanMeta', 'checkStreamEq', 'editRange', 'applyEdits', 'applyEdit',
  'findTokAtOff', 'findTokAtOffKind', 'reconstructParens', 'parenStacksEq', 'windowRelexStep', 'relexEdits'];

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };
const seen = new Set<string>();

for (const f of FIXTURES) {
  const grammar = (await import(f.path)).default;
  const ir = portableIR(grammar);
  const mode = relexMode(ir);
  const name = modeName(mode);
  seen.add(name);
  if (name !== f.mode) fail(`${f.path}: expected mode ${f.mode}, got ${name}`);
  const expected = new Set(relexFamilyFns(mode).map((fn) => fn.name));
  for (const h of HOSTS) {
    const out = emitParser(grammar, h.target);
    const family = emitRelexFamily(ir, h.target.lowering);
    const at = out.indexOf(family);
    if (at < 0) { fail(`${f.path}/${h.host}: output does not embed the generated family verbatim`); continue; }
    if (out.indexOf(family, at + 1) >= 0) fail(`${f.path}/${h.host}: family embedded twice`);
    for (const fn of FAMILY_NAMES) {
      const n = (out.match(h.def(fn)) ?? []).length;
      const want = expected.has(fn) ? 1 : 0;
      if (n !== want) fail(`${f.path}/${h.host}: ${fn} defined ${n}×, want ${want}`);
    }
  }
  console.log(`  ${f.path}: ${name} — family embedded once per host, ${expected.size} functions`);
}

for (const m of ['plain', 'newline', 'regex', 'template', 'regex+template', 'full-relex']) {
  if (!seen.has(m)) fail(`no fixture covers lexer mode ${m}`);
}

if (failures > 0) {
  console.error(`\n✗ relex family: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n✓ relex family: one source, embedded verbatim in ts/go/rust, every lexer mode covered');
