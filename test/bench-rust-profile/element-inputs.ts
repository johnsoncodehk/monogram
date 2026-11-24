// node element-inputs.ts <tsc tests/cases dir> <out dir> [--oxc-check=<oxc-check binary>]: the
// profile's element inputs, built from the pinned tsc corpus (the same tree ci.yml checks out at
// TS_REPO_SHA; nothing else is read). No real TSX / JSX file of size exists in the repository's
// corpora or node_modules, so each input is the real element code there is: every `.tsx` part (a
// file, or a `// @filename: x.tsx` part of a test) outside fourslash that contains a tag, which
// tsc's parser (ScriptKind TSX), this tree's interpreter (typescriptreact.ts) AND oxc (source type
// TSX) all accept, in path order, joined by `\n;\n` (an empty statement, so no part's last token
// joins the next part's first by ASI), less any part that exports a name an earlier one exported (the
// joined text is one module); likewise for javascriptreact.ts (ScriptKind JSX, oxc JSX)
// every `.jsx` or `.tsx` part that is JavaScript (the `.jsx` parts alone are 2.4 KB; most of the
// JSX tests are `.tsx` files written without type syntax). Writes <out>/jsx-corpus.tsx and
// <out>/jsx-corpus.jsx and prints one line per input. The joined text is checked once more: an
// input the interpreter rejects as a whole fails here, not as a silent REJECT in the profile.
//
// oxc's acceptance is the profile's own (test/bench-rust-oxc/oxc-check.rs, built only at full
// scope): the parts it rejects are pinned in OXC_REJECTS below, so both scopes build the same
// inputs without oxc. With --oxc-check (run.sh passes it at full scope) the pin is checked: every
// candidate part and each joined input go through oxc-check, and a part oxc rejects that the pin
// lacks, or a pinned part it now accepts, fails here with the corrected entries (a moved
// TS_REPO_SHA or oxc version moves them).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'tsc-oracle';
import { createParser } from '../../src/gen-parser.ts';

// The parts oxc (oxc_parser 0.126, test/oxc-parse-bench/Cargo.lock) rejects although tsc's parser
// and the interpreter accept them: key (the test file relative to tests/cases, then `:` and the
// `@filename` of the part when the test has several) -> oxc's first error. They are left out so the
// profile's element rows compare the two parsers on code both accept.
const OXC_REJECTS: Record<'.tsx' | '.jsx', Record<string, string>> = {
  // `<div<>>`, `<MyComp<> a={10} …>`: an empty type-argument list on a tag. TypeArgumentList has at
  // least one type, so oxc is right; tsc's parser takes it (its checker reports it) and so does
  // typescriptreact.ts: an over-acceptance of the interpreter, owed to the grammar lane
  '.tsx': {
    'compiler/jsxIntrinsicElementsTypeArgumentErrors.tsx': 'Type argument list cannot be empty.',
    'conformance/jsx/tsxTypeArgumentResolution.tsx:file.tsx': 'Type argument list cannot be empty.',
  },
  '.jsx': {},
};

const args = process.argv.slice(2);
const [root, out] = args.filter((a) => !a.startsWith('--'));
const oxcCheck = args.find((a) => a.startsWith('--oxc-check='))?.slice('--oxc-check='.length);
if (!root || !out) throw new Error('usage: element-inputs.ts <tests/cases dir> <out dir> [--oxc-check=<bin>]');
const walk = (d: string): string[] =>
  readdirSync(d).sort().flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? (n === 'fourslash' ? [] : walk(p)) : [p]; });
const parts: { key: string; name: string; src: string }[] = [];
for (const f of walk(root)) {
  if (!/\.[jt]sx?$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  const re = /^\/\/\s*@filename:\s*(\S+).*$/gim;
  let last = 0, name = f, m: RegExpExecArray | null;
  const mine: { key: string; name: string; src: string }[] = [];
  while ((m = re.exec(text))) { mine.push({ key: rel, name, src: text.slice(last, m.index) }); name = m[1]!; last = m.index + m[0].length; }
  mine.push({ key: rel, name, src: text.slice(last) });
  if (mine.length > 1) mine.forEach((p, i) => { p.key = `${rel}:${i === 0 ? '' : p.name}`; });
  parts.push(...mine);
}

// oxc-check over the given texts, each written as <dir>/<i><ext>: the first error of each rejected one.
const oxcVerdicts = (dir: string, ext: string, texts: string[]): (string | null)[] => {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const files = texts.map((t, i) => { const p = `${dir}/${i}${ext}`; writeFileSync(p, t); return p; });
  const res: (string | null)[] = texts.map(() => null);
  for (let i = 0; i < files.length; i += 500) {
    const lines = execFileSync(oxcCheck!, files.slice(i, i + 500), { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
    lines.forEach((l, j) => {
      const m = /^REJECT (\S+)/.exec(l);
      if (m) res[files.indexOf(m[1]!)] = /message: "((?:[^"\\]|\\.)*)"/.exec(lines[j + 1] ?? '')?.[1] ?? 'rejected';
    });
  }
  rmSync(dir, { recursive: true, force: true });
  return res;
};

// The names a module part exports (tsc's AST): `default` for a default export, the bound names of
// an exported declaration, the exported names of an export clause (`export * as ns` included).
function exportedNames(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const bound = (n: ts.BindingName) => { if (ts.isIdentifier(n)) out.push(n.text); else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bound(e.name); };
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) { out.push('default'); continue; }
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) out.push(e.name.text);
      else if (st.exportClause) out.push(st.exportClause.name.text);
      continue;
    }
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) { out.push('default'); continue; }
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bound(d.name);
    else if ('name' in st && st.name && ts.isIdentifier(st.name as ts.Node)) out.push((st.name as ts.Identifier).text);
  }
  return out;
}

let pinStale = false;
for (const [ext, kind, gname, from] of [['.tsx', ts.ScriptKind.TSX, 'typescriptreact', ['.tsx']], ['.jsx', ts.ScriptKind.JSX, 'javascriptreact', ['.jsx', '.tsx']]] as const) {
  const { parse } = createParser((await import(`../../${gname}.ts`)).default);
  const ok = (s: string) => { try { parse(s); return true; } catch { return false; } };
  const sel = parts.filter((p) => from.some((e) => p.name.toLowerCase().endsWith(e)) && /<[\w>]/.test(p.src));
  const tscOk = sel.filter((p) => !(ts.createSourceFile('t' + ext, p.src, ts.ScriptTarget.Latest, true, kind) as any).parseDiagnostics.length);
  const both = tscOk.filter((p) => ok(p.src));
  const pin = OXC_REJECTS[ext];
  if (oxcCheck) {
    const v = oxcVerdicts(`${out}/oxc-check-parts`, ext, both.map((p) => p.src));
    const now = new Map(both.flatMap((p, i) => (v[i] !== null ? [[p.key, v[i]!] as const] : [])));
    const added = [...now].filter(([k]) => !(k in pin)), gone = Object.keys(pin).filter((k) => !now.has(k));
    if (added.length || gone.length) {
      pinStale = true;
      console.log(`jsx-corpus${ext}: OXC_REJECTS is stale (${added.length} part(s) oxc rejects are missing, ${gone.length} pinned part(s) it accepts); the entries, as they should be:`);
      for (const [k, why] of [...now].sort()) console.log(`    ${JSON.stringify(k)}: ${JSON.stringify(why)},`);
    }
  }
  // Joined, the parts are one module: a part that exports a name an earlier part exported (`export
  // const a`, a second `export default`) is left out, or the joined text has a duplicated export,
  // which oxc reports (as an early error of the module) where the parts alone pass.
  const exported = new Set<string>();
  let dupExports = 0;
  const all3 = both.filter((p) => !(p.key in pin)).filter((p) => {
    const names = exportedNames(ts.createSourceFile('t' + ext, p.src, ts.ScriptTarget.Latest, true, kind));
    if (names.some((n) => exported.has(n))) { dupExports++; return false; }
    for (const n of names) exported.add(n);
    return true;
  });
  const text = all3.map((p) => p.src).join('\n;\n');
  if (!ok(text)) throw new Error(`jsx-corpus${ext}: the joined parts are rejected by ${gname}.ts`);
  if (oxcCheck && !pinStale) {
    const [why] = oxcVerdicts(`${out}/oxc-check-parts`, ext, [text]);
    if (why !== null) throw new Error(`jsx-corpus${ext}: the joined parts are rejected by oxc: ${why}`);
  }
  writeFileSync(`${out}/jsx-corpus${ext}`, text);
  console.log(`jsx-corpus${ext}: ${all3.length} parts (of ${sel.length} with a tag; tsc accepts ${tscOk.length}, and the interpreter ${both.length}; oxc rejects ${Object.keys(pin).length} of those${oxcCheck ? ', checked' : ', pinned'}; ${dupExports} left out for an export an earlier part made), ${Buffer.byteLength(text)} bytes`);
}
if (pinStale) process.exit(1);
