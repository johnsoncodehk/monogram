// Gate: the WORK a portable parser does per token does not grow with nesting depth.
//
// The portable parsers choose a rule's alternative by longest match: every candidate its Guard
// admits is tried, and one that matches without ending past the best so far is thrown away. When
// two candidates of one list both parse the same construct in full, that construct is parsed
// twice — and when it nests in itself, every level doubles the work again (2^depth). Parity
// cannot see this (the tree is the same); a wall-clock check on a shared runner cannot hold a
// bound. A work count can: it is deterministic and the same number in every target.
//
// The count is taken through the public Builder API of each emitted parser (TS `parseWith`, Go
// `ParseWith`, Rust `parse_with`) with a builder that forwards to the CST builder and counts the
// nodes it is asked to build — nodes of attempts that lose included. It is taken for the
// typescript grammar and for the javascript grammar, each with its own constructs (the javascript
// list has no type syntax). Per construct, the input is one statement nested in the construct 1
// and DEEP times:
//   • nodes built per token at depth DEEP is at most GROWTH × the same at depth 1;
//   • every target reports the same token and node counts.
// A construct in KNOWN_GROWTH is still run: it is an existing site that grows, listed with the
// two candidates that parse it, and the gate fails when it stops growing until its entry is
// removed. Missing go / rustc → logged + skipped.
//
//   node test/portable-work.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/targets/target.ts';
import { tsTarget } from '../src/targets/target-ts.ts';
import { goTarget } from '../src/targets/target-go.ts';
import { rustTarget } from '../src/targets/target-rust.ts';
import { scratchDir } from './scratch.ts';
import { cachedGoBuild, cachedRustc, RUSTC_LINTS } from './build-cache.ts';

const DEEP = 8, GROWTH = 2;

const stmt = 'const v = f(1, [a, b], { k: 2 });';
const nest = (d: number, open: (i: number) => string, close: string, inner = stmt): string => {
  let s = inner;
  for (let i = 0; i < d; i++) s = `${open(i)}\n${s}\n${close}`;
  return s + '\n';
};
const wrap = (d: number, open: string, close: string, inner: string): string => `${open.repeat(d)}${inner}${close.repeat(d)}`;
const TS_CONSTRUCTS: Record<string, (d: number) => string> = {
  'export namespace': (d) => nest(d, (i) => `export namespace N${i} {`, '}'),
  'namespace': (d) => nest(d, (i) => `namespace N${i} {`, '}'),
  'module': (d) => nest(d, (i) => `module M${i} {`, '}'),
  'declare namespace': (d) => 'declare ' + nest(d, (i) => `namespace N${i} {`, '}', 'const v: number;'),
  'export function': (d) => nest(d, (i) => `export function f${i}() {`, '}'),
  'export async function': (d) => nest(d, (i) => `export async function f${i}() {`, '}'),
  'function declaration': (d) => nest(d, (i) => `function f${i}(a: number) {`, '}'),
  'async function': (d) => nest(d, (i) => `async function f${i}() {`, '}'),
  'function expression': (d) => nest(d, (i) => `const g${i} = function () {`, '};'),
  'arrow function, block body': (d) => nest(d, (i) => `const g${i} = (a, b) => {`, '};'),
  'arrow function, expression body': (d) => `const z = ${'(a) => '.repeat(d)}1;\n`,
  'callback argument': (d) => nest(d, (i) => `f${i}(() => {`, '});'),
  'class method': (d) => nest(d, (i) => `class C${i} { m${i}() {`, '} }'),
  'class static method': (d) => nest(d, (i) => `class C${i} { static m${i}() {`, '} }'),
  'class modified method': (d) => nest(d, (i) => `class C${i} { public async m${i}(): void {`, '} }'),
  'class accessor': (d) => nest(d, (i) => `class C${i} { get m${i}() {`, '} }'),
  'class field': (d) => nest(d, (i) => `class C${i} { m${i} = () => {`, '} }'),
  'class constructor': (d) => nest(d, (i) => `class C${i} { constructor() {`, '} }'),
  'class expression': (d) => nest(d, (i) => `const K${i} = class { m${i}() {`, '} };'),
  'export class': (d) => nest(d, (i) => `export class C${i} { m${i}() {`, '} }'),
  'abstract class': (d) => nest(d, (i) => `abstract class C${i} { m${i}() {`, '} }'),
  'export abstract class': (d) => nest(d, (i) => `export abstract class C${i} { m${i}() {`, '} }'),
  'decorated class': (d) => nest(d, (i) => `@dec class C${i} { @dec m${i}() {`, '} }'),
  'decorated abstract class': (d) => nest(d, (i) => `@dec abstract class C${i} { m${i}() {`, '} }'),
  'decorated export class': (d) => nest(d, (i) => `@dec export class C${i} { m${i}() {`, '} }'),
  'export decorated class': (d) => nest(d, (i) => `export @dec class C${i} { m${i}() {`, '} }'),
  'object method': (d) => nest(d, (i) => `const o${i} = { m${i}() {`, '} };'),
  'object accessor': (d) => nest(d, (i) => `const o${i} = { get m${i}() {`, '} };'),
  'object property function': (d) => nest(d, (i) => `const o${i} = { m${i}: function () {`, '} };'),
  'object property arrow': (d) => nest(d, (i) => `const o${i} = { m${i}: () => {`, '} };'),
  'object literal': (d) => `const o = ${wrap(d, '{ a: ', ' }', '1')};\n`,
  'object computed key': (d) => `const o = ${wrap(d, '{ [k]: ', ' }', '1')};\n`,
  'object modified async method': (d) => nest(d, (i) => `const o${i} = { public static async m${i}() {`, '} };'),
  'array literal': (d) => `const o = ${wrap(d, '[', ']', '1')};\n`,
  'array of objects': (d) => `const o = ${wrap(d, '[{ a: ', ' }]', '1')};\n`,
  // Lists: each kind nested in itself, with its last element right before the close (where an
  // element parsed by a repetition that then wants a separator would be parsed again).
  'array, last of two': (d) => `const o = ${wrap(d, '[0, ', ']', '1')};\n`,
  'array, trailing comma': (d) => `const o = ${wrap(d, '[', ',]', '1')};\n`,
  'array, elisions': (d) => `const o = ${wrap(d, '[, ', ', ,]', '1')};\n`,
  'array, spread': (d) => `const o = ${wrap(d, '[0, ...', ']', 'x')};\n`,
  'array destructuring assignment': (d) => `${wrap(d, '[', ']', 'a')} = x;\n`,
  'array binding pattern': (d) => `const ${wrap(d, '[b, ', ']', 'a')} = x;\n`,
  'var array binding pattern': (d) => `var ${wrap(d, '[b, ', ']', 'a')} = x;\n`,
  'arrow array parameter': (d) => `const f = (${wrap(d, '[', ']', 'a')}) => 1;\n`,
  'arrow default parameter': (d) => `const f = ${wrap(d, '(a = ', ') => 1', '1')};\n`,
  'object pattern': (d) => `const ${wrap(d, '{ b, a: ', ' }', 'a')} = x;\n`,
  'call, last of two': (d) => `${wrap(d, 'f(0, ', ')', '1')};\n`,
  'call, trailing comma': (d) => `${wrap(d, 'f(', ',)', '1')};\n`,
  'parentheses': (d) => `const o = ${wrap(d, '(', ')', '1')};\n`,
  'call arguments': (d) => `${wrap(d, 'f(', ')', '1')};\n`,
  'generic call': (d) => `${wrap(d, 'f<T>(', ')', '1')};\n`,
  'new expression': (d) => `const o = ${wrap(d, 'new A(', ')', '1')};\n`,
  'conditional expression': (d) => `const o = ${wrap(d, 'a ? ', ' : 2', '1')};\n`,
  'as expression': (d) => `const o = ${wrap(d, '(', ' as any)', '1')};\n`,
  'angle-bracket assertion': (d) => `const o = ${wrap(d, '<any>(', ')', '1')};\n`,
  'template literal': (d) => `const o = ${wrap(d, '`a${', '}`', '1')};\n`,
  'block': (d) => nest(d, () => '{', '}'),
  'if': (d) => nest(d, () => 'if (a) {', '}'),
  'if else': (d) => nest(d, () => 'if (a) { b(); } else {', '}'),
  'for': (d) => nest(d, () => 'for (let i = 0; i < n; i++) {', '}'),
  'for of': (d) => nest(d, () => 'for (const x of xs) {', '}'),
  'while': (d) => nest(d, () => 'while (a) {', '}'),
  'try': (d) => nest(d, () => 'try {', '} catch (e) { g(); }'),
  'switch': (d) => nest(d, () => 'switch (a) { case 1: {', '} }'),
  'labelled block': (d) => nest(d, (i) => `l${i}: {`, '}'),
  'type literal': (d) => `type T = ${wrap(d, '{ a: ', ' }', 'number')};\n`,
  'type arguments': (d) => `type T = ${wrap(d, 'A<', '>', 'number')};\n`,
  'tuple type': (d) => `type T = ${wrap(d, '[', ']', 'number')};\n`,
  'tuple, last of two': (d) => `type T = ${wrap(d, '[0, ', ']', 'number')};\n`,
  'named tuple': (d) => `type T = ${wrap(d, '[a?: ', ']', 'number')};\n`,
  'rest tuple': (d) => `type T = ${wrap(d, '[0, ...', ']', 'number')};\n`,
  'type arguments, last of two': (d) => `type T = ${wrap(d, 'A<0, ', '>', 'number')};\n`,
  'union, leading pipe': (d) => `type T = ${wrap(d, '| (', ')', 'number')};\n`,
  'function type': (d) => `type T = ${wrap(d, '(a: ', ') => void', 'number')};\n`,
  'conditional type': (d) => `type T = ${wrap(d, 'A extends B ? ', ' : 2', '1')};\n`,
};

// EXPECTED-FAIL: constructs whose work per token grows with depth today, each with the candidates
// that parse it more than once. Each is owed its own change (a grammar decision, or an engine
// mechanism that shares a sub-parse between candidates).
const TS_KNOWN_GROWTH: Record<string, string> = {
  'arrow default parameter': "Expr: `(a = …)` is parsed by the arrow arm as a parameter list and by the parenthesized arm as `(Expr)`, so a default that holds an arrow function is parsed twice per level",
};

// The javascript grammar's constructs: what is JavaScript (no type syntax), each nested in itself.
// An `export` or a decorator nests too: the grammar reads a declaration in a function body as in a
// module, so nesting is what shows a declaration parsed twice.
const JS_CONSTRUCTS: Record<string, (d: number) => string> = {
  'function declaration': (d) => nest(d, (i) => `function f${i}(a, b) {`, '}'),
  'async function': (d) => nest(d, (i) => `async function f${i}() {`, '}'),
  'generator function': (d) => nest(d, (i) => `function* f${i}() {`, '}'),
  'async generator function': (d) => nest(d, (i) => `async function* f${i}() {`, '}'),
  'function expression': (d) => nest(d, (i) => `const g${i} = function () {`, '};'),
  'named function expression': (d) => nest(d, (i) => `const g${i} = function h${i}() {`, '};'),
  'generator expression': (d) => nest(d, (i) => `const g${i} = function* () {`, '};'),
  'immediately invoked function': (d) => nest(d, () => '(function () {', '})();'),
  'arrow function, block body': (d) => nest(d, (i) => `const g${i} = (a, b) => {`, '};'),
  'arrow function, expression body': (d) => `const z = ${'(a) => '.repeat(d)}1;\n`,
  'async arrow function': (d) => nest(d, (i) => `const g${i} = async (a) => {`, '};'),
  'callback argument': (d) => nest(d, (i) => `f${i}(() => {`, '});'),
  'class method': (d) => nest(d, (i) => `class C${i} { m${i}() {`, '} }'),
  'class static method': (d) => nest(d, (i) => `class C${i} { static m${i}() {`, '} }'),
  'class async method': (d) => nest(d, (i) => `class C${i} { async m${i}() {`, '} }'),
  'class static async method': (d) => nest(d, (i) => `class C${i} { static async m${i}() {`, '} }'),
  'class generator method': (d) => nest(d, (i) => `class C${i} { *m${i}() {`, '} }'),
  'class async generator method': (d) => nest(d, (i) => `class C${i} { async *m${i}() {`, '} }'),
  'class accessor': (d) => nest(d, (i) => `class C${i} { get m${i}() {`, '} }'),
  'class setter': (d) => nest(d, (i) => `class C${i} { set m${i}(v) {`, '} }'),
  'class private method': (d) => nest(d, (i) => `class C${i} { #m${i}() {`, '} }'),
  'class computed method': (d) => nest(d, (i) => `class C${i} { [k${i}]() {`, '} }'),
  'class field': (d) => nest(d, (i) => `class C${i} { m${i} = () => {`, '} }'),
  'class static field': (d) => nest(d, (i) => `class C${i} { static m${i} = () => {`, '} }'),
  'class private field': (d) => nest(d, (i) => `class C${i} { #m${i} = () => {`, '} }'),
  'class static block': (d) => nest(d, (i) => `class C${i} { static {`, '} }'),
  'class constructor': (d) => nest(d, (i) => `class C${i} { constructor() {`, '} }'),
  'class extends': (d) => nest(d, (i) => `class C${i} extends B { constructor() { super();`, '} }'),
  'class expression': (d) => nest(d, (i) => `const K${i} = class { m${i}() {`, '} };'),
  'named class expression': (d) => nest(d, (i) => `const K${i} = class C${i} { m${i}() {`, '} };'),
  'decorated class': (d) => nest(d, (i) => `@dec class C${i} { @dec m${i}() {`, '} }'),
  'decorated class, called decorator': (d) => nest(d, (i) => `@dec(1) class C${i} { m${i}() {`, '} }'),
  'decorated method': (d) => nest(d, (i) => `class C${i} { @dec m${i}() {`, '} }'),
  'decorated field': (d) => nest(d, (i) => `class C${i} { @dec m${i} = () => {`, '} }'),
  'decorated class expression': (d) => nest(d, (i) => `const K${i} = @dec class { m${i}() {`, '} };'),
  'decorated export class': (d) => nest(d, (i) => `@dec export class C${i} { m${i}() {`, '} }'),
  'export decorated class': (d) => nest(d, (i) => `export @dec class C${i} { m${i}() {`, '} }'),
  'export default decorated class': (d) => nest(d, (i) => `export default @dec class C${i} { m${i}() {`, '} }'),
  'decorated export default class': (d) => nest(d, (i) => `@dec export default class C${i} { m${i}() {`, '} }'),
  'export class': (d) => nest(d, (i) => `export class C${i} { m${i}() {`, '} }'),
  'export default class': (d) => nest(d, (i) => `export default class C${i} { m${i}() {`, '} }'),
  'export function': (d) => nest(d, (i) => `export function f${i}() {`, '}'),
  'export async function': (d) => nest(d, (i) => `export async function f${i}() {`, '}'),
  'export default function': (d) => nest(d, (i) => `export default function f${i}() {`, '}'),
  'export const': (d) => nest(d, (i) => `export const g${i} = () => {`, '};'),
  'object method': (d) => nest(d, (i) => `const o${i} = { m${i}() {`, '} };'),
  'object async method': (d) => nest(d, (i) => `const o${i} = { async m${i}() {`, '} };'),
  'object generator method': (d) => nest(d, (i) => `const o${i} = { *m${i}() {`, '} };'),
  'object accessor': (d) => nest(d, (i) => `const o${i} = { get m${i}() {`, '} };'),
  'object computed method': (d) => nest(d, (i) => `const o${i} = { [k${i}]() {`, '} };'),
  'object property function': (d) => nest(d, (i) => `const o${i} = { m${i}: function () {`, '} };'),
  'object property arrow': (d) => nest(d, (i) => `const o${i} = { m${i}: () => {`, '} };'),
  'object literal': (d) => `const o = ${wrap(d, '{ a: ', ' }', '1')};\n`,
  'object computed key': (d) => `const o = ${wrap(d, '{ [k]: ', ' }', '1')};\n`,
  'object spread': (d) => `const o = ${wrap(d, '{ ...', ' }', 'x')};\n`,
  'array literal': (d) => `const o = ${wrap(d, '[', ']', '1')};\n`,
  'array of objects': (d) => `const o = ${wrap(d, '[{ a: ', ' }]', '1')};\n`,
  // Lists: each kind nested in itself, with its last element right before the close (where an
  // element parsed by a repetition that then wants a separator would be parsed again).
  'array, last of two': (d) => `const o = ${wrap(d, '[0, ', ']', '1')};\n`,
  'array, trailing comma': (d) => `const o = ${wrap(d, '[', ',]', '1')};\n`,
  'array, elisions': (d) => `const o = ${wrap(d, '[, ', ', ,]', '1')};\n`,
  'array, spread': (d) => `const o = ${wrap(d, '[0, ...', ']', 'x')};\n`,
  'array destructuring assignment': (d) => `${wrap(d, '[', ']', 'a')} = x;\n`,
  'array binding pattern': (d) => `const ${wrap(d, '[b, ', ']', 'a')} = x;\n`,
  'var array binding pattern': (d) => `var ${wrap(d, '[b, ', ']', 'a')} = x;\n`,
  'arrow array parameter': (d) => `const f = (${wrap(d, '[', ']', 'a')}) => 1;\n`,
  'arrow default parameter': (d) => `const f = ${wrap(d, '(a = ', ') => 1', '1')};\n`,
  'object pattern': (d) => `const ${wrap(d, '{ b, a: ', ' }', 'a')} = x;\n`,
  'call, last of two': (d) => `${wrap(d, 'f(0, ', ')', '1')};\n`,
  'call, trailing comma': (d) => `${wrap(d, 'f(', ',)', '1')};\n`,
  'parentheses': (d) => `const o = ${wrap(d, '(', ')', '1')};\n`,
  'call arguments': (d) => `${wrap(d, 'f(', ')', '1')};\n`,
  'optional call': (d) => `${wrap(d, 'f?.(', ')', '1')};\n`,
  'new expression': (d) => `const o = ${wrap(d, 'new A(', ')', '1')};\n`,
  'conditional expression': (d) => `const o = ${wrap(d, 'a ? ', ' : 2', '1')};\n`,
  'template literal': (d) => `const o = ${wrap(d, '`a${', '}`', '1')};\n`,
  'tagged template': (d) => `const o = ${wrap(d, 'tag`a${', '}`', '1')};\n`,
  'block': (d) => nest(d, () => '{', '}'),
  'if': (d) => nest(d, () => 'if (a) {', '}'),
  'if else': (d) => nest(d, () => 'if (a) { b(); } else {', '}'),
  'else if': (d) => nest(d, () => 'if (a) { b(); } else if (c) {', '}'),
  'for': (d) => nest(d, () => 'for (let i = 0; i < n; i++) {', '}'),
  'for of': (d) => nest(d, () => 'for (const x of xs) {', '}'),
  'for in': (d) => nest(d, () => 'for (const k in o) {', '}'),
  'while': (d) => nest(d, () => 'while (a) {', '}'),
  'do while': (d) => nest(d, () => 'do {', '} while (a);'),
  'try': (d) => nest(d, () => 'try {', '} catch (e) { g(); }'),
  'try finally': (d) => nest(d, () => 'try {', '} finally { g(); }'),
  'switch': (d) => nest(d, () => 'switch (a) { case 1: {', '} }'),
  'labelled block': (d) => nest(d, (i) => `l${i}: {`, '}'),
  'labelled loop': (d) => nest(d, (i) => `l${i}: for (;;) {`, '}'),
};

// EXPECTED-FAIL, as TS_KNOWN_GROWTH.
const JS_KNOWN_GROWTH: Record<string, string> = {
  'arrow default parameter': "Expr: `(a = …)` is parsed by the arrow arm as a parameter list and by the parenthesized arm as `(Expr)`, so a default that holds an arrow function is parsed twice per level",
};

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };
const haveGo = have('go', 'version'), haveRust = have('rustc', '--version');
if (!haveGo) console.log('  go: (toolchain not found — skipped)');
if (!haveRust) console.log('  rust: (toolchain not found — skipped)');

type Count = { toks: number; nodes: number } | null;   // null: the input was rejected
// A consumer binary prints one line per input file: `<tokens>\t<nodes>`, or `reject`.
const readCounts = (out: string): Count[] => out.trim().split('\n').map((l) => {
  if (l === 'reject') return null;
  const [toks, nodes] = l.split('\t').map(Number);
  return { toks: toks!, nodes: nodes! };
});

// Every target's counts for one grammar's inputs, in their order.
async function measure(grammar: Parameters<typeof emitParser>[0], dir: string, inputs: string[]): Promise<Map<string, Count[]>> {
  const files = inputs.map((src, i) => { const f = join(dir, `in${i}.txt`); writeFileSync(f, src); return f; });
  const counts = new Map<string, Count[]>();

  // ── TS ──
  {
    const file = join(dir, 'parser.ts');
    writeFileSync(file, emitParser(grammar, tsTarget));
    const m = await import(file);
    counts.set('ts', inputs.map((src): Count => {
      let nodes = 0;
      const root = m.parseWith(src, {
        leaf: (tt: string, kid: number, lid: number, off: number, end: number) => m.cstBuilder.leaf(tt, kid, lid, off, end),
        node: (rule: string, children: unknown[], off: number, end: number) => { nodes++; return m.cstBuilder.node(rule, children, off, end); },
      });
      return root === null ? null : { toks: m.tokenize(src).length, nodes };
    }));
  }

  // ── Go ──
  if (haveGo) {
    const gdir = join(dir, 'go');
    mkdirSync(join(gdir, 'parser'), { recursive: true });
    writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
    writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(grammar, goTarget));
    writeFileSync(join(gdir, 'main.go'), `package main

import (
	"fmt"
	"os"

	"consumer/parser"
)

// Not a *parser.CstBuilder, so ParseWith drives it through the Builder interface.
type counting struct {
	*parser.CstBuilder
	nodes int
}

func (c *counting) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []parser.Tok) (int32, uint32, bool) {
	c.nodes++
	return c.CstBuilder.Finish(scratch, sb, ruleId, fallbackOff, tokStart, tokEnd, toks)
}

func main() {
	for _, f := range os.Args[1:] {
		b, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		src := string(b)
		c := &counting{CstBuilder: &parser.CstBuilder{}}
		if _, ok := parser.ParseWith(src, c); !ok {
			fmt.Println("reject")
			continue
		}
		toks, err := parser.Tokenize(src)
		if err != nil {
			panic(err)
		}
		fmt.Printf("%d\\t%d\\n", len(toks), c.nodes)
	}
}
`);
    cachedGoBuild(['-o', 'consumer', '.'], { cwd: gdir });
    counts.set('go', readCounts(execFileSync(join(gdir, 'consumer'), files, { encoding: 'utf8' })));
  }

  // ── Rust ──
  if (haveRust) {
    const rfile = join(dir, 'work.rs');
    writeFileSync(rfile, emitParser(grammar, rustTarget) + `
#[derive(Default)]
struct Counting { inner: CstBuilder, nodes: u64 }
impl Builder for Counting {
    type H = i32;
    fn dummy_h() -> i32 { 0 }
    fn checkpoint(&self) -> (usize, usize) { self.inner.checkpoint() }
    fn restore(&mut self, ck: (usize, usize)) { self.inner.restore(ck) }
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt: u16, ti: u32, off: u32, end: u32) -> bool { self.inner.leaf(scratch, tt, ti, off, end) }
    fn finish(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok]) -> (i32, u32, bool) {
        self.nodes += 1;
        self.inner.finish(scratch, sb, rule_id, fallback_off, tok_start, tok_end, toks)
    }
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        self.inner.node(scratch, sb, rule_id, off, end, tok_start, tok_end)
    }
    fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) { self.inner.span_of(h, toks) }
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) { self.inner.head_span(h, toks) }
    fn note_look(&mut self, h: i32, max_look: u32) { self.inner.note_look(h, max_look) }
    fn entry_meta(&mut self, h: i32, max_look: u32, toks: &[Tok]) -> EntryMeta { self.inner.entry_meta(h, max_look, toks) }
    fn tok_range(&self, h: i32) -> (u32, u32) { self.inner.tok_range(h) }
    fn toks(&self) -> Option<&Vec<Tok>> { self.inner.toks() }
    fn toks_mut(&mut self) -> Option<&mut Vec<Tok>> { self.inner.toks_mut() }
}
fn main() {
    for f in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&f).unwrap();
        let mut c = Counting::default();
        match parse_with(&src, &mut c) {
            Some(_) => println!("{}\\t{}", tokenize(&src).unwrap().len(), c.nodes),
            None => println!("reject"),
        }
    }
}
`);
    cachedRustc([...RUSTC_LINTS, rfile, '-o', join(dir, 'work')], { stdio: 'pipe' });
    counts.set('rust', readCounts(execFileSync(join(dir, 'work'), files, { encoding: 'utf8' })));
  }
  return counts;
}

const GRAMMARS = [
  { name: 'typescript', constructs: TS_CONSTRUCTS, known: TS_KNOWN_GROWTH },
  { name: 'javascript', constructs: JS_CONSTRUCTS, known: JS_KNOWN_GROWTH },
];
const dir = scratchDir('portable-work');
const summary: string[] = [];
let targets: string[] = [];
for (const { name, constructs, known } of GRAMMARS) {
  const grammar = (await import(`../${name}.ts`)).default;
  const gdir = join(dir, name);
  mkdirSync(gdir);
  const names = Object.keys(constructs);
  // Two inputs per construct, in `names` order: depth 1, then depth DEEP.
  const counts = await measure(grammar, gdir, names.flatMap((n) => [constructs[n]!(1), constructs[n]!(DEEP)]));
  targets = [...counts.keys()];
  const growth = (cs: Count[], k: number) => {
    const flat = cs[2 * k], deep = cs[2 * k + 1];
    return flat && deep ? (deep.nodes / deep.toks) / (flat.nodes / flat.toks) : NaN;
  };

  const [ref, ...others] = [...counts];
  const [refLabel, refCounts] = ref!;
  for (const [label, cs] of others) {
    const diff = names.flatMap((n, k) => [1, DEEP].flatMap((d, j) => {
      const a = refCounts[2 * k + j], b = cs[2 * k + j];
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${n} ×${d}: ${refLabel} ${JSON.stringify(a)} vs ${label} ${JSON.stringify(b)}`];
    }));
    check(`${name} ${label}: token and node counts ≡ ${refLabel}`, diff.length === 0, diff.slice(0, 3).join('; '));
  }
  for (const [label, cs] of counts) {
    names.forEach((n, k) => {
      const flat = cs[2 * k], deep = cs[2 * k + 1];
      if (flat == null || deep == null) { check(`${name} ${label}: ${n} is accepted at depth 1 and ${DEEP}`, false, flat == null ? 'depth 1 rejected' : `depth ${DEEP} rejected`); return; }
      const g = growth(cs, k);
      const detail = `nodes built per token ${(flat.nodes / flat.toks).toFixed(2)} at depth 1, ${(deep.nodes / deep.toks).toFixed(2)} at depth ${DEEP} (×${g.toFixed(2)})`;
      if (known[n] === undefined) check(`${name} ${label}: ${n} — work per token does not grow with depth`, g <= GROWTH, detail);
      else check(`${name} ${label}: ${n} — KNOWN_GROWTH entry still grows (remove the entry once it does not)`, g > GROWTH, detail);
    });
  }
  for (const n of Object.keys(known)) check(`${name} KNOWN_GROWTH names a construct: ${n}`, n in constructs);

  const free = names.map((n, k) => ({ n, g: growth(refCounts, k) })).filter((x) => !(x.n in known)).sort((a, b) => b.g - a.g)[0]!;
  summary.push(`${name}: ${names.length} constructs, largest growth outside KNOWN_GROWTH ×${free.g.toFixed(2)} (${free.n}), ${Object.keys(known).length} known to grow`);
}
console.log(`portable-work: depth 1 and ${DEEP}, targets ${targets.join(' / ')}\n  ${summary.join('\n  ')}`);
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
