// Gate: each portable target's emitted file is a LIBRARY whose public tokenizer is usable from
// another module and owns its results.
//
//   TS   — imported as an ES module: tokenize() returns fresh caller-owned tokens; neither a
//          CST from parse() nor a createDoc() session notices interleaved tokenize() calls.
//   Go   — built as `package parser` inside a module and imported by a separate main package:
//          parser.Tokenize / parser.ParseWith; a caller-owned *CstBuilder is untouched by Tokenize;
//          malformed input yields a *LexError; the package exports only its API. Each Doc owns
//          its tree: interleaved Docs / ParseWith calls never disturb another Doc's incremental
//          edit (≡ a fresh Doc, with reuse), and Docs used from concurrent goroutines (built
//          with the race detector when available) match the sequential results.
//   Rust — compiled with --crate-type lib and linked into a separate crate: parser::tokenize /
//          Doc; a Doc session with tokenize interleaved ≡ a fresh Doc after an edit; malformed
//          input panics with the lexer message (the crate's documented lexical error mechanism).
// Every target's token stream (kind/text/off/end/nl) is identical, and identical to the
// frozen lexer golden (type/span/newlineBefore). Missing go/rustc → logged + skipped.
//
//   node test/emit-portable-library.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { goldenStream } from './golden-lexer.ts';

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
const BAD_LEX = 'let a = 1 # 2;';
// `null` cannot head a qualified type (the parser reads that leaf's source text), so NLL is
// rejected while NLL_OTHER, with the same token offsets, is accepted.
const NLL = 'let a: null.x = 1;';
const NLL_OTHER = 'let b: qqqq.x = 1;';
const badLex = goldenStream('typescript', BAD_LEX);
const refLexError = badLex !== undefined && 'error' in badLex ? badLex.error : '';
// ASCII-only samples, so a JSON string literal is also a valid Go and Rust string literal.
const lit = (s: string) => JSON.stringify(s);

type Tok5 = { kind: string; text: string; off: number; end: number; nl: boolean };
const five = (ts: { kind: string; text: string; off: number; end: number; nl: boolean }[]): Tok5[] =>
  ts.map(({ kind, text, off, end, nl }) => ({ kind, text, off, end, nl }));
const ref = (s: string): Tok5[] => {
  const g = goldenStream('typescript', s);
  if (g === undefined || !Array.isArray(g)) throw new Error(`no golden token stream for ${JSON.stringify(s)}`);
  return g.map(([kind, off, len, fl]) => ({ kind, text: s.slice(off, off + len), off, end: off + len, nl: (fl & 1) !== 0 }));
};
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
  check('ts: tokenize ≡ lexer golden', json(five(tA)) === json(ref(A)));
  const t1 = m.tokenize(B), t2 = m.tokenize(B);
  check('ts: tokenize returns a fresh array of fresh objects', t1 !== t2 && t1.every((t: object, i: number) => t !== t2[i]));
  let tsErr = '';
  try { m.tokenize(BAD_LEX); } catch (e) { tsErr = (e as Error).message; }
  check('ts: tokenize throws the lexer error on malformed input', refLexError !== '' && tsErr === refLexError, `${tsErr} vs ${refLexError}`);
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
  const goSrc = emitParser(grammar, goTarget);
  writeFileSync(join(gdir, 'parser', 'parser.go'), goSrc);
  // The exported surface is the tokenizer, the Doc/builder API and the tables a custom
  // Builder needs — no generated rule helper or lexer constant.
  const GO_API = new Set(['Tokenize', 'Token', 'LexError', 'Error', 'Tok', 'Node', 'Edit', 'Align', 'EntryMeta', 'Seg', 'Doc', 'NewDoc', 'DocWith', 'NewDocWith', 'Document',
    'SetValidate', 'Text', 'Root', 'Builder', 'Shifter', 'CstBuilder', 'SlimBuilder', 'Checkpoint', 'Restore', 'Leaf', 'Finish', 'SpanOf', 'HeadSpan', 'Shift',
    'ParseWith', 'CstJSONWith', 'SlimJSONWith', 'CstJSON', 'TT_NAMES', 'RULE_NAMES', 'TT_SKIP_PUNCT']);
  const exported = [...goSrc.matchAll(/^(?:func (?:\([^)]*\) )?|type |var |const )([A-Z]\w*)/gm)].map((x) => x[1]!);
  const extra = [...new Set(exported.filter((x) => !GO_API.has(x)))];
  check('go: package parser exports only its API', extra.length === 0, extra.slice(0, 12).join(' '));
  writeFileSync(join(gdir, 'main.go'), `package main

import (
\t"encoding/json"
\t"errors"
\t"os"
\t"reflect"
\t"strings"
\t"sync"
\t"sync/atomic"

\t"consumer/parser"
)

func main() {
\tb := &parser.CstBuilder{}
\th, ok := parser.ParseWith(${lit(A)}, b)
\tnodes := append([]parser.Node(nil), b.Nodes...)
\tkids := append([]int32(nil), b.Kids...)
\tt1, _ := parser.Tokenize(${lit(B)})
\tt1[0].Text = "MUTATED"
\tt2, _ := parser.Tokenize(${lit(B)})
\tbad, lexErr := parser.Tokenize(${lit(BAD_LEX)})
\tvar le *parser.LexError
\tlexMsg, lexOff := "", -1
\tif errors.As(lexErr, &le) { lexMsg, lexOff = le.Msg, le.Off }
\ttA, _ := parser.Tokenize(${lit(A)})
\tunchanged := reflect.DeepEqual(nodes, b.Nodes) && reflect.DeepEqual(kids, b.Kids)
\tb2 := &parser.CstBuilder{}
\th2, ok2 := parser.ParseWith(${lit(A)}, b2)
\tsame := h == h2 && ok2 && reflect.DeepEqual(b.Nodes, b2.Nodes) && reflect.DeepEqual(b.Kids, b2.Kids)
\tbig := strings.Repeat("let q = [1, 2, 3];\\n", 40)
\tbigEdit := []parser.Edit{{Start: len(big), End: len(big), Text: "let w = 2;\\n"}}
\taEdit := []parser.Edit{{Start: ${EDIT.start}, End: ${EDIT.end}, Text: ${lit(EDIT.text)}}}
\tdA := parser.NewDoc(${lit(A)})
\tdBig := parser.NewDoc(big)
\tparser.ParseWith(${lit(B)}, &parser.CstBuilder{})
\tcb := &parser.CstBuilder{}
\tdC := parser.NewDocWith(${lit(A)}, cb).(*parser.Doc)
\tdA.Edit(aEdit)
\tdBig.Edit(bigEdit)
\twantA := parser.NewDoc(${lit(EDITED)}).CstJSON()
\twantBig := parser.NewDoc(big + "let w = 2;\\n").CstJSON()
\tisoA := dA.CstJSON() == wantA && dA.Align().Reused > 0
\tisoBig := dBig.CstJSON() == wantBig && dBig.Align().Reused > 0
\townB := len(cb.Nodes) > 0 && dC.CstJSON() == parser.NewDoc(${lit(A)}).CstJSON()
\tdNull := parser.NewDoc(${lit(NLL)})
\tparser.ParseWith(${lit(NLL_OTHER)}, &parser.CstBuilder{})
\tdNull.Edit([]parser.Edit{{Start: ${NLL.length}, End: ${NLL.length}, Text: " "}})
\townSrc := dNull.Root() < 0 && parser.NewDoc(${lit(NLL + ' ')}).Root() < 0 && parser.NewDoc(${lit(NLL_OTHER + ' ')}).Root() >= 0
\tvar wg sync.WaitGroup
\tvar badConc atomic.Int32
\tfor g := 0; g < 8; g++ {
\t\twg.Add(1)
\t\tgo func(g int) {
\t\t\tdefer wg.Done()
\t\t\tfor i := 0; i < 25; i++ {
\t\t\t\tif (g+i)%2 == 0 {
\t\t\t\t\td := parser.NewDoc(${lit(A)}); d.Edit(aEdit)
\t\t\t\t\tif d.CstJSON() != wantA { badConc.Add(1) }
\t\t\t\t} else {
\t\t\t\t\td := parser.NewDoc(big); d.Edit(bigEdit)
\t\t\t\t\tif d.CstJSON() != wantBig { badConc.Add(1) }
\t\t\t\t}
\t\t\t\tparser.Tokenize(${lit(B)})
\t\t\t\tparser.ParseWith(${lit(B)}, &parser.CstBuilder{})
\t\t\t}
\t\t}(g)
\t}
\twg.Wait()
\tjson.NewEncoder(os.Stdout).Encode(map[string]any{"ok": ok, "unchanged": unchanged, "same": same, "tokensA": tA, "tokensB": t2, "badNil": bad == nil, "lexMsg": lexMsg, "lexOff": lexOff,
\t\t"isoA": isoA, "isoBig": isoBig, "ownB": ownB, "ownSrc": ownSrc, "badConc": badConc.Load()})
}
`);
  try {
    let race = true;
    try { execFileSync('go', ['build', '-race', '-o', 'consumer', '.'], { cwd: gdir, stdio: 'pipe' }); }
    catch { race = false; execFileSync('go', ['build', '-o', 'consumer', '.'], { cwd: gdir, stdio: 'pipe' }); }
    const out = JSON.parse(execFileSync(join(gdir, 'consumer'), { encoding: 'utf8' }));
    const lower = (ts: { Kind: string; Text: string; Off: number; End: number; Nl: boolean }[]) =>
      ts.map((t) => ({ kind: t.Kind, text: t.Text, off: t.Off, end: t.End, nl: t.Nl }));
    check('go: external package builds against parser.Tokenize / parser.ParseWith', out.ok === true);
    check('go: Tokenize ≡ lexer golden', json(lower(out.tokensA)) === json(ref(A)));
    check('go: a mutated Tokenize result does not leak into the next call', json(lower(out.tokensB)) === json(ref(B)));
    check('go: a caller-owned CstBuilder is untouched by Tokenize', out.unchanged === true);
    check('go: ParseWith after Tokenize(other) ≡ ParseWith alone', out.same === true);
    check('go: Tokenize returns a *LexError (nil tokens) on malformed input', out.badNil === true && out.lexMsg === refLexError && out.lexOff === BAD_LEX.indexOf('#'), `${out.lexMsg} @${out.lexOff}`);
    check('go: a Doc edit after other Docs / ParseWith ≡ a fresh Doc, with reuse', out.isoA === true && out.isoBig === true);
    check('go: NewDocWith(*CstBuilder) builds its tree into that builder', out.ownB === true);
    check('go: a Doc reparsing after a rejected text reads its own source, not the last parsed one', out.ownSrc === true);
    check(`go: Docs on concurrent goroutines ≡ sequential results (race detector ${race ? 'on' : 'unavailable'})`, out.badConc === 0, `${out.badConc} mismatches`);
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
    std::panic::set_hook(Box::new(|_| {}));
    let lex_msg = match std::panic::catch_unwind(|| tokenize(${lit(BAD_LEX)}).len()) {
        Ok(_) => String::new(),
        Err(p) => p.downcast_ref::<String>().cloned().unwrap_or_default(),
    };
    let _ = std::panic::take_hook();
    let after_panic = toks_json(&tokenize(b));
    println!("{{\\"unchanged\\":{},\\"editEq\\":{},\\"tokensA\\":{},\\"tokensB\\":{},\\"lexMsg\\":{:?},\\"afterPanic\\":{}}}", unchanged, edit_eq, toks_json(&tokenize(a)), toks_json(&t2), lex_msg, after_panic);
}
`);
  try {
    execFileSync('rustc', ['-A', 'warnings', '--crate-type', 'lib', '--crate-name', 'parser', 'parser.rs'], { cwd: rdir, stdio: 'pipe' });
    execFileSync('rustc', ['--edition', '2021', 'main.rs', '--extern', 'parser=libparser.rlib', '-o', 'consumer'], { cwd: rdir, stdio: 'pipe' });
    const out = JSON.parse(execFileSync(join(rdir, 'consumer'), { encoding: 'utf8' }));
    check('rust: external crate links against parser::tokenize / parser::Doc', true);
    check('rust: tokenize ≡ lexer golden', json(out.tokensA) === json(ref(A)));
    check('rust: tokenize returns an independent Vec', json(out.tokensB) === json(ref(B)));
    check('rust: a Doc is untouched by tokenize', out.unchanged === true);
    check('rust: Doc edit with tokenize interleaved ≡ fresh Doc', out.editEq === true);
    check('rust: tokenize panics with the lexer message on malformed input (documented)', out.lexMsg === refLexError, out.lexMsg);
    check('rust: tokenize works after a caught lexer panic', json(out.afterPanic) === json(ref(B)));
  } catch (e) {
    check('rust: library crate builds, links and runs', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800));
  }
}

console.log(`\n${ok}/${ok + fail} portable-library checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
