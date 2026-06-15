// angle-depth-probe.ts — the depth gate for the DELIMITER + LOOKAHEAD nesting class (TS/TSX angle
// brackets), the category that had ZERO depth coverage and where the type-cast `\g<TC>` cliff lived.
//
// Two structural checks over the GENERATED typescript/typescriptreact/javascript/javascriptreact
// grammars, so a new construct cannot be added without this gate seeing it:
//
//   PART 1 — DEPTH SWEEP (self-baselining). The angle-bracket disambiguations (generic call, type
//   cast, generic arrow, JSX tag type-args, generic type) confirm `<…>` is a type span. A confirm
//   built on an Oniguruma `\g<>` subroutine has a ~20-level recursion cap, so a deep nested generic
//   flips the discriminating scope at d=20 (the cast did exactly this: `<` → relational at d=20).
//   For each construct we sweep d=1,5,19,20,24,30 and assert the probe token's scope at every depth
//   EQUALS its shallow (d=1) value — a flip anywhere is a depth cliff. Self-baselining, so it is
//   robust to scope renames; it would have caught the cast cliff (gen-tm 1967) and the TSX arrow
//   cliff (the formerly-recursive arrowEndConfirm) before they shipped.
//
//   PART 2 — `\g<>` CENSUS. Every Oniguruma subroutine `\g<>` reachable from a begin/match/while/end
//   in the emitted grammars is enumerated and matched against an ALLOWLIST of graceful-degraders
//   (a `\g<>` inside a negative lookahead or an optional group, whose overflow is benign). A `\g<>`
//   NOT on the list is a latent sole-confirmer cliff → FAIL, forcing a flat-confirm migration (as
//   done for generic-call/arrow/cast) or an explicit, depth-probed allowlist entry. This makes the
//   cast-cliff class structurally un-missable: it walks the EMITTED output, not a hand list.
//
// Run (bare node): node test/angle-depth-probe.ts   ·   Exit 0 iff no cliff AND census clean.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const { INITIAL, Registry } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

async function load(path: string) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const reg = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (ps: string[]) => new OnigScanner(ps),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (scope: string) => (scope === raw.scopeName ? raw : null),
  });
  return reg.loadGrammar(raw.scopeName);
}

const TS = await load('./typescript.tmLanguage.json');
const TSX = await load('./typescriptreact.tmLanguage.json');

// scope of the FIRST token whose text === `needle` (optionally the nth), innermost scope.
function scopeOf(g: any, src: string, needle: string, nth = 1): string | null {
  const lines = src.split('\n');
  let rs = INITIAL;
  let seen = 0;
  for (const line of lines) {
    const r = g.tokenizeLine(line, rs);
    for (const t of r.tokens) {
      if (line.slice(t.startIndex, t.endIndex) === needle && ++seen === nth) return t.scopes[t.scopes.length - 1];
    }
    rs = r.ruleStack;
  }
  return null;
}

// A d-deep nested generic type span: A0<A1<…<X>…>>  (no spaces, the densest form).
const nest = (d: number) => {
  let s = 'X';
  for (let i = 0; i < d; i++) s = `A${i}<${s}>`;
  return s;
};

interface Construct {
  name: string;
  g: any;
  build: (d: number) => string;
  needle: string;   // token whose scope must stay stable across depth
  nth?: number;
}

const CONSTRUCTS: Construct[] = [
  { name: 'generic-call (ts)', g: TS, build: (d) => `const z = f<${nest(d)}>(0);\n`, needle: '<' },
  { name: 'type-cast (ts)', g: TS, build: (d) => `const x = <${nest(d)}>v;\n`, needle: '<' },
  { name: 'generic-type-annotation (ts)', g: TS, build: (d) => `let a: ${nest(d)};\n`, needle: '<' },
  { name: 'generic-arrow (tsx)', g: TSX, build: (d) => `const f = <T extends ${nest(d)}>(p: T) => p;\n`, needle: 'p', nth: 1 },
  { name: 'jsx-tag-type-args (tsx)', g: TSX, build: (d) => `const e = <Comp<${nest(d)}> a={1} />;\n`, needle: 'Comp' },
];

const DEPTHS = [1, 5, 19, 20, 24, 30];
const cliffs: string[] = [];

for (const c of CONSTRUCTS) {
  const baseline = scopeOf(c.g, c.build(1), c.needle, c.nth);
  const row: string[] = [];
  for (const d of DEPTHS) {
    const sc = scopeOf(c.g, c.build(d), c.needle, c.nth);
    const ok = sc === baseline;
    row.push(`d${d}:${ok ? 'ok' : 'FLIP'}`);
    if (!ok) cliffs.push(`${c.name} «${c.needle}» d=${d}: ${sc}  (shallow was ${baseline})`);
  }
  console.log(`  ${c.name.padEnd(30)} «${c.needle}»→${baseline}\n      ${row.join('  ')}`);
}

// PART 2 — \g<> census over the emitted grammars.
// Allowlist: a graceful-degrader is a `\g<>` whose overflow is benign — inside a NEGATIVE lookahead
// (the bail-out just doesn't fire) or an OPTIONAL group (a flat fallback follows). Each entry names
// the repository key + subroutine and WHY it is safe.
const ALLOW: { grammar: RegExp; keyRe: RegExp; sub: string; why: string }[] = [
  { grammar: /typescript(react)?/, keyRe: /generic-call-multiline/, sub: 'B', why: 'inside a NEGATIVE lookahead (?!…) — overflow makes the bail-out not fire (benign), verified stable to d=30' },
  { grammar: /typescriptreact/, keyRe: /jsx/, sub: 'TA', why: 'inside an OPTIONAL group (?:…)? with a flat [^>]* fallback — overflow falls back to the region, verified stable to d=30' },
];
const census: string[] = [];
const unrecognized: string[] = [];
for (const [gf] of [['typescript.tmLanguage.json'], ['typescriptreact.tmLanguage.json'], ['javascript.tmLanguage.json'], ['javascriptreact.tmLanguage.json']] as const) {
  const g = JSON.parse(readFileSync(`./${gf}`, 'utf8'));
  const walk = (node: any, key: string) => {
    if (!node || typeof node !== 'object') return;
    for (const f of ['begin', 'match', 'while', 'end'] as const) {
      const re = node[f];
      if (typeof re === 'string') {
        for (const m of re.matchAll(/\\g<([^>]*)>/g)) {
          const sub = m[1];
          census.push(`${gf}:${key}.${f}:\\g<${sub}>`);
          const ok = ALLOW.some((a) => a.grammar.test(gf) && a.keyRe.test(key) && a.sub === sub);
          if (!ok) unrecognized.push(`${gf} ${key}.${f} \\g<${sub}>`);
        }
      }
    }
    for (const k in node) if (k !== 'repository' && typeof node[k] === 'object') walk(node[k], key);
  };
  for (const k in (g.repository || {})) walk(g.repository[k], k);
}

console.log(`\n  \\g<> census: ${census.length} subroutine use(s); ${unrecognized.length} unrecognized (not a known graceful-degrader)`);
for (const u of unrecognized) console.log(`    UNRECOGNIZED \\g<> (latent depth cliff — flat-migrate or allowlist with a depth-probe): ${u}`);

const fail = cliffs.length + unrecognized.length;
if (cliffs.length) { console.log('\n  DEPTH CLIFFS:'); for (const c of cliffs) console.log(`    ${c}`); }
console.log(fail === 0
  ? '\n✓ no angle-bracket depth cliff (stable to d=30) and \\g<> census clean'
  : `\n✗ ${cliffs.length} cliff(s) + ${unrecognized.length} unrecognized \\g<>`);
process.exit(fail === 0 ? 0 : 1);
