// Gate: each portable target's emitted file is a LIBRARY whose public tokenizer is usable from
// another module and owns its results.
//
//   TS   — imported as an ES module: tokenize() returns fresh caller-owned tokens; neither a
//          CST from parse() nor a createDoc() session notices interleaved tokenize() calls.
//   Go   — built as `package parser` inside a module and imported by a separate main package:
//          parser.Tokenize / parser.ParseWith; a caller-owned *CstBuilder is untouched by Tokenize.
//   Rust — compiled with --crate-type lib and linked into a separate crate: parser::tokenize /
//          Doc; a Doc session with tokenize interleaved ≡ a fresh Doc after an edit.
// Every target's token stream (kind/text/off/end/nl) is identical, and identical to the
// interpreter's createLexer (type/text/offset/newlineBefore). Missing go/rustc → logged + skipped.
//
//   node test/emit-portable-library.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { createLexer } from '../src/gen-lexer.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string) => { try { execFileSync(cmd, ['version'], { stdio: 'pipe' }); return true; } catch { try { execFileSync(cmd, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } } };

const grammar = (await import('../typescript.ts')).default;
const A = 'function foo(a) { return a + 1; }\nfoo(`t${2}`);\nconst r = /x+/g;\n';
const B = 'let b = c / d\n++e;\n';
const EDIT = { start: A.indexOf('a + 1'), end: A.indexOf('a + 1') + 5, text: 'a * 2' };
const EDITED = A.slice(0, EDIT.start) + EDIT.text + A.slice(EDIT.end);
// ASCII-only samples, so a JSON string literal is also a valid Go and Rust string literal.
const lit = (s: string) => JSON.stringify(s);

type Tok5 = { kind: string; text: string; off: number; end: number; nl: boolean };
const five = (ts: { kind: string; text: string; off: number; end: number; nl: boolean }[]): Tok5[] =>
  ts.map(({ kind, text, off, end, nl }) => ({ kind, text, off, end, nl }));
const ref = (s: string): Tok5[] =>
  createLexer(grammar).tokenize(s).map((t) => ({ kind: t.type, text: t.text, off: t.offset, end: t.offset + t.text.length, nl: t.newlineBefore }));
const json = (v: unknown) => JSON.stringify(v);
const dir = mkdtempSync(join(tmpdir(), 'monogram-portable-library-'));

// Lexing modes the portable lexers do not implement must be refused, not mis-lexed.
for (const [mode, path] of [['markup', '../html.ts'], ['indent', '../yaml.ts']]) {
  const g = (await import(path)).default;
  for (const t of [tsTarget, goTarget, rustTarget]) {
    let msg = '';
    try { emitParser(g, t); } catch (e) { msg = (e as Error).message; }
    check(`${t.name}: a ${mode}-mode grammar is rejected`, msg.includes(`${mode}`), msg || 'emitted without error');
  }
}

// ── TS ──
{
  const file = join(dir, 'parser.ts');
  writeFileSync(file, emitParser(grammar, tsTarget));
  const m = await import(file);
  const tA = m.tokenize(A);
  check('ts: tokenize ≡ createLexer', json(five(tA)) === json(ref(A)));
  const t1 = m.tokenize(B), t2 = m.tokenize(B);
  check('ts: tokenize returns a fresh array of fresh objects', t1 !== t2 && t1.every((t: object, i: number) => t !== t2[i]));
  const cst = m.parse(A);
  const before = json(cst);
  m.tokenize(B);
  check('ts: a parse() CST is unaffected by tokenize()', cst !== null && json(cst) === before);
  check('ts: parse() after tokenize(other) ≡ parse() alone', json(m.parse(A)) === before);
  const d = m.createDoc(A);
  m.tokenize(B);
  d.edit([EDIT]);
  m.tokenize(B);
  check('ts: createDoc edit with tokenize interleaved ≡ fresh parse', json(d.root()) === json(m.parse(EDITED)));
}

// ── Go ──
if (!have('go')) console.log('  go: (toolchain not found — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(join(gdir, 'parser'), { recursive: true });
  writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
  writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(grammar, goTarget));
  writeFileSync(join(gdir, 'main.go'), `package main

import (
\t"encoding/json"
\t"os"
\t"reflect"

\t"consumer/parser"
)

func main() {
\tb := &parser.CstBuilder{}
\th, ok := parser.ParseWith(${lit(A)}, b)
\tnodes := append([]parser.Node(nil), b.Nodes...)
\tkids := append([]int32(nil), b.Kids...)
\tt1 := parser.Tokenize(${lit(B)})
\tt1[0].Text = "MUTATED"
\tt2 := parser.Tokenize(${lit(B)})
\tunchanged := reflect.DeepEqual(nodes, b.Nodes) && reflect.DeepEqual(kids, b.Kids)
\tb2 := &parser.CstBuilder{}
\th2, ok2 := parser.ParseWith(${lit(A)}, b2)
\tsame := h == h2 && ok2 && reflect.DeepEqual(b.Nodes, b2.Nodes) && reflect.DeepEqual(b.Kids, b2.Kids)
\tjson.NewEncoder(os.Stdout).Encode(map[string]any{"ok": ok, "unchanged": unchanged, "same": same, "tokensA": parser.Tokenize(${lit(A)}), "tokensB": t2})
}
`);
  try {
    execFileSync('go', ['build', '-o', 'consumer', '.'], { cwd: gdir, stdio: 'pipe' });
    const out = JSON.parse(execFileSync(join(gdir, 'consumer'), { encoding: 'utf8' }));
    const lower = (ts: { Kind: string; Text: string; Off: number; End: number; Nl: boolean }[]) =>
      ts.map((t) => ({ kind: t.Kind, text: t.Text, off: t.Off, end: t.End, nl: t.Nl }));
    check('go: external package builds against parser.Tokenize / parser.ParseWith', out.ok === true);
    check('go: Tokenize ≡ createLexer', json(lower(out.tokensA)) === json(ref(A)));
    check('go: a mutated Tokenize result does not leak into the next call', json(lower(out.tokensB)) === json(ref(B)));
    check('go: a caller-owned CstBuilder is untouched by Tokenize', out.unchanged === true);
    check('go: ParseWith after Tokenize(other) ≡ ParseWith alone', out.same === true);
  } catch (e) {
    check('go: external package builds and runs', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800));
  }
}

// ── Rust ──
if (!have('rustc')) console.log('  rust: (toolchain not found — skipped)');
else {
  const rdir = join(dir, 'rust');
  mkdirSync(rdir);
  writeFileSync(join(rdir, 'parser.rs'), emitParser(grammar, rustTarget));
  writeFileSync(join(rdir, 'main.rs'), `use parser::{tokenize, Doc, Edit, Token};

fn toks_json(t: &[Token]) -> String {
    let items: Vec<String> = t.iter().map(|t| format!("{{\\"kind\\":{:?},\\"text\\":{:?},\\"off\\":{},\\"end\\":{},\\"nl\\":{}}}", t.kind, t.text, t.off, t.end, t.nl)).collect();
    format!("[{}]", items.join(","))
}

fn main() {
    let a = ${lit(A)};
    let b = ${lit(B)};
    let mut d: Doc = Doc::new(a.to_string());
    let before = d.cst_json();
    let mut t1 = tokenize(b);
    t1.clear();
    let t2 = tokenize(b);
    let unchanged = before.is_some() && d.cst_json() == before;
    d.edit(&[Edit { start: ${EDIT.start}, end: ${EDIT.end}, text: ${lit(EDIT.text)}.to_string() }]);
    let _ = tokenize(b);
    let fresh: Doc = Doc::new(${lit(EDITED)}.to_string());
    let edit_eq = d.cst_json().is_some() && d.cst_json() == fresh.cst_json();
    println!("{{\\"unchanged\\":{},\\"editEq\\":{},\\"tokensA\\":{},\\"tokensB\\":{}}}", unchanged, edit_eq, toks_json(&tokenize(a)), toks_json(&t2));
}
`);
  try {
    execFileSync('rustc', ['-A', 'warnings', '--crate-type', 'lib', '--crate-name', 'parser', 'parser.rs'], { cwd: rdir, stdio: 'pipe' });
    execFileSync('rustc', ['--edition', '2021', 'main.rs', '--extern', 'parser=libparser.rlib', '-o', 'consumer'], { cwd: rdir, stdio: 'pipe' });
    const out = JSON.parse(execFileSync(join(rdir, 'consumer'), { encoding: 'utf8' }));
    check('rust: external crate links against parser::tokenize / parser::Doc', true);
    check('rust: tokenize ≡ createLexer', json(out.tokensA) === json(ref(A)));
    check('rust: tokenize returns an independent Vec', json(out.tokensB) === json(ref(B)));
    check('rust: a Doc is untouched by tokenize', out.unchanged === true);
    check('rust: Doc edit with tokenize interleaved ≡ fresh Doc', out.editEq === true);
  } catch (e) {
    check('rust: library crate builds, links and runs', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800));
  }
}

console.log(`\n${ok}/${ok + fail} portable-library checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
