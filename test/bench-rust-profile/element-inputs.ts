// node element-inputs.ts <tsc tests/cases dir> <out dir>: the profile's element inputs, built from
// the pinned tsc corpus (the same tree ci.yml checks out at TS_REPO_SHA; nothing else is read). No
// real TSX / JSX file of size exists in the repository's corpora or node_modules, so each input is
// the real element code there is: every `.tsx` part (a file, or a `// @filename: x.tsx` part of a
// test) outside fourslash that contains a tag, which tsc's parser (ScriptKind TSX) AND this tree's
// interpreter (typescriptreact.ts) both accept, in path order, joined by `\n;\n` (an empty
// statement, so no part's last token joins the next part's first by ASI); likewise for
// javascriptreact.ts (ScriptKind JSX) every `.jsx` or `.tsx` part that is JavaScript (the `.jsx`
// parts alone are 2.4 KB; most of the JSX tests are `.tsx` files written without type syntax). Writes <out>/jsx-corpus.tsx and
// <out>/jsx-corpus.jsx and prints one line per input. The joined text is checked once more: an
// input the interpreter rejects as a whole fails here, not as a silent REJECT in the profile.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { createParser } from '../../src/gen-parser.ts';

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error('usage: element-inputs.ts <tests/cases dir> <out dir>');
const walk = (d: string): string[] =>
  readdirSync(d).sort().flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? (n === 'fourslash' ? [] : walk(p)) : [p]; });
const parts: { name: string; src: string }[] = [];
for (const f of walk(root)) {
  if (!/\.[jt]sx?$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  const re = /^\/\/\s*@filename:\s*(\S+).*$/gim;
  let last = 0, name = f, m: RegExpExecArray | null;
  while ((m = re.exec(text))) { parts.push({ name, src: text.slice(last, m.index) }); name = m[1]!; last = m.index + m[0].length; }
  parts.push({ name, src: text.slice(last) });
}
for (const [ext, kind, gname, from] of [['.tsx', ts.ScriptKind.TSX, 'typescriptreact', ['.tsx']], ['.jsx', ts.ScriptKind.JSX, 'javascriptreact', ['.jsx', '.tsx']]] as const) {
  const { parse } = createParser((await import(`../../${gname}.ts`)).default);
  const ok = (s: string) => { try { parse(s); return true; } catch { return false; } };
  const sel = parts.filter((p) => from.some((e) => p.name.toLowerCase().endsWith(e)) && /<[\w>]/.test(p.src));
  const tscOk = sel.filter((p) => !(ts.createSourceFile('t' + ext, p.src, ts.ScriptTarget.Latest, true, kind) as any).parseDiagnostics.length);
  const both = tscOk.filter((p) => ok(p.src));
  const text = both.map((p) => p.src).join('\n;\n');
  if (!ok(text)) throw new Error(`jsx-corpus${ext}: the joined parts are rejected by ${gname}.ts`);
  writeFileSync(`${out}/jsx-corpus${ext}`, text);
  console.log(`jsx-corpus${ext}: ${both.length} parts (of ${sel.length} with a tag; tsc accepts ${tscOk.length}), ${Buffer.byteLength(text)} bytes`);
}
