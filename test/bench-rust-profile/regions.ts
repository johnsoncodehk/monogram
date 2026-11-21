// node regions.ts <mono|oxc> <callgrind.out> [main.rs] : a phase breakdown of one Callgrind profile.
//
// Callgrind attributes each instruction to the source file:line its debug line table names, and an
// inlined body keeps the file:line of the code it came from. So summing self cost by source line
// (not by symbol) recovers inlined boundaries: CstBuilder::finish inlined into a rule function still
// counts against CstBuilder::finish's lines. For monogram, main.rs lines are mapped to the innermost
// enclosing `fn` (and its impl/trait) by scanning main.rs; for oxc, by crate and source directory.
// Standard-library code inlined anywhere has no grammar-level owner of its own: it is reported
// under the symbol (machine-code function) it was inlined into. libc (malloc, memcpy, ...) is its
// own symbol and is reported by name.
//
// Prints: total Ir; Ir by phase; top source-level functions (inlined code included, self cost);
// top symbols by self cost; and for monogram a matrix of which symbol class the builder code runs in.
// Requires a profile written with --compress-strings=no --compress-pos=no --dump-instr=no.
import { readFileSync } from 'node:fs';

const [kind, cgFile, mainRs] = process.argv.slice(2);
const TOP = 40;

// ---- callgrind reader: self cost per (object, symbol, file, line) ----
type Cost = { obj: string; fn: string; file: string; line: number; ir: number };
const costs: Cost[] = [];
let total = 0;
{
  let ob = '', fl = '', fi = '', fn = '';
  let callPending = false;
  const agg = new Map<string, Cost>();
  for (const raw of readFileSync(cgFile, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    if (c0 >= 48 && c0 <= 57) {
      const [pos, ir] = line.split(' ').map(Number);
      if (callPending) { callPending = false; continue; } // inclusive cost of a call, not self
      const file = fi || fl;
      const key = ob + '\0' + fn + '\0' + file + '\0' + pos;
      const e = agg.get(key);
      if (e) e.ir += ir || 0; else agg.set(key, { obj: ob, fn, file, line: pos, ir: ir || 0 });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      if (line.startsWith('totals:') || line.startsWith('summary:')) total = Math.max(total, Number(line.split(/\s+/)[1]));
      continue;
    }
    const k = line.slice(0, eq), v = line.slice(eq + 1);
    if (k === 'ob') ob = v;
    else if (k === 'fl') { fl = v; fi = ''; }
    else if (k === 'fi' || k === 'fe') fi = v;
    else if (k === 'fn') { fn = v; fi = ''; }
    else if (k === 'calls') callPending = true;
  }
  costs.push(...agg.values());
}
const selfSum = costs.reduce((s, c) => s + c.ir, 0);

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number) => ((100 * n) / selfSum).toFixed(1).padStart(5) + '%';
function table(title: string, m: Map<string, number>, top = TOP) {
  console.log(`\n-- ${title}`);
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [k, v] of rows) console.log(`${fmt(v).padStart(15)} ${pct(v)}  ${k}`);
}
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) || 0) + v);

const isStd = (f: string) => /\/rustc\/[0-9a-f]+\/library\/|\/library\/(core|alloc|std)\/src\//.test(f);
const stdShort = (f: string) => f.replace(/^.*\/library\//, '');
function libcClass(fn: string): string | null {
  if (/^(__libc_)?(malloc|calloc|realloc|free|_int_malloc|_int_free|_int_realloc|malloc_consolidate|unlink_chunk|sysmalloc|tcache|_int_free_merge|_int_free_create|_int_free_maybe)/.test(fn) || /malloc|_int_free|realloc|cfree|tcache/.test(fn)) return 'heap: malloc/realloc/free (libc)';
  if (/mem(cpy|move|set)|__memcpy|__memmove|__memset/.test(fn)) return 'memcpy/memmove/memset (libc)';
  if (/mmap|munmap|mremap|brk|madvise/.test(fn)) return 'kernel calls (mmap/munmap/brk)';
  return null;
}

// ---- monogram: main.rs line -> innermost fn and its impl/trait header ----
type Owner = { fn: string; ctx: string };
function ownersOf(src: string): Owner[] {
  const lines = src.split('\n');
  const out: Owner[] = new Array(lines.length + 2).fill(null).map(() => ({ fn: '<top>', ctx: '' }));
  const stack: { kind: 'fn' | 'ctx' | 'blk'; name: string }[] = [];
  let pendingFn: string | null = null, pendingCtx: string | null = null, ctxText = '';
  let i = 0, line = 1;
  const n = src.length;
  const cur = (): Owner => {
    let fn = '<top>', ctx = '';
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].kind === 'fn' && fn === '<top>') fn = stack[j].name;
      if (stack[j].kind === 'ctx' && !ctx) ctx = stack[j].name;
    }
    return { fn, ctx };
  };
  out[1] = cur();
  const ident = /[A-Za-z0-9_]/;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; out[line] = cur(); i++; if (pendingCtx !== null) ctxText += ' '; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { line++; out[line] = cur(); } i++; } i += 2; continue; }
    if (ch === 'r' && (src[i + 1] === '"' || (src[i + 1] === '#' && /^#+"/.test(src.slice(i + 1, i + 20)))) && !ident.test(src[i - 1] || '')) {
      let j = i + 1, h = 0; while (src[j] === '#') { h++; j++; }
      const close = '"' + '#'.repeat(h); j++;
      const e = src.indexOf(close, j);
      for (let q = i; q < e; q++) if (src[q] === '\n') { line++; out[line] = cur(); }
      i = e + close.length; continue;
    }
    if (ch === '"') {
      i++; while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; else if (src[i] === '\n') { line++; out[line] = cur(); } i++; } i++; continue;
    }
    if (ch === "'") {
      // char literal ('x', '\n', '\u{..}') vs lifetime ('a)
      if (src[i + 1] === '\\') { const e = src.indexOf("'", i + 2); i = e + 1; continue; }
      const cp = src.codePointAt(i + 1)!; const w = cp > 0xffff ? 2 : 1;
      if (src[i + 1 + w] === "'") { i += 2 + w; continue; }
      i++; continue;
    }
    if (ident.test(ch) && !ident.test(src[i - 1] || '')) {
      let j = i; while (j < n && ident.test(src[j])) j++;
      const word = src.slice(i, j);
      if (pendingCtx !== null) ctxText += word;
      if (word === 'fn') {
        const m = /^\s+([A-Za-z0-9_]+)/.exec(src.slice(j, j + 200));
        if (m) pendingFn = m[1];
      } else if ((word === 'impl' || word === 'trait') && pendingFn === null && pendingCtx === null) {
        pendingCtx = word; ctxText = word;
      }
      i = j; continue;
    }
    if (ch === '{') {
      if (pendingFn !== null) { stack.push({ kind: 'fn', name: pendingFn }); pendingFn = null; }
      else if (pendingCtx !== null) { stack.push({ kind: 'ctx', name: ctxText.replace(/\s+/g, ' ').trim() }); pendingCtx = null; }
      else stack.push({ kind: 'blk', name: '' });
      i++; continue;
    }
    if (ch === '}') { stack.pop(); i++; continue; }
    if (ch === ';') { if (pendingFn !== null) pendingFn = null; if (pendingCtx !== null) pendingCtx = null; i++; continue; }
    if (pendingCtx !== null) ctxText += ch;
    i++;
  }
  return out;
}

function monoClass(o: Owner, ln: number, lexEnd: number): string {
  const { fn, ctx } = o;
  if (fn.startsWith('mono_prof_')) return 'driver';
  if (/Builder for CstBuilder|^impl CstBuilder|^trait Builder/.test(ctx)) return 'CST builder (CstBuilder methods, Builder defaults)';
  if (['encode_leaf', 'decode_leaf', 'leaf_end', 'gt_op'].includes(fn)) return 'leaf handle encode/decode, leaf span';
  if (/^impl\b.*\bParser</.test(ctx)) {
    if (fn.startsWith('parse_') || /^[A-Z]\w*?_(pre|post|nud|bp|bin|led)$/.test(fn)) return 'rule functions (parse_*, Pratt *_nud/_bp/_bin/_pre/_post)';
    return 'parser engine (Parser helpers: peek, match_*, finish wrapper, ...)';
  }
  if (fn === 'parse_with') return 'parse_with (entry: moves, Vec take)';
  if (ln < lexEnd || /^(lex|tok_|in_lex)/.test(fn) || /RxTplScan/.test(ctx)) return 'lexer (lex, lex_from, scanners)';
  if (fn === 'tokenize') return 'tokenize mapping';
  if (fn === 'in_token_set') return 'parser engine (Parser helpers: peek, match_*, finish wrapper, ...)';
  return `other main.rs: ${ctx ? ctx + ' :: ' : ''}${fn}`;
}
function monoSymClass(sym: string): string {
  if (/mono_prof_/.test(sym) && !/::/.test(sym.replace(/^mono_bench_\w+::/, ''))) return 'driver';
  if (/\blex(_|\b)|lex_from|RxTplScan|tokenize/.test(sym)) return 'lexer symbols';
  if (/parse_with/.test(sym)) return 'parse_with';
  if (/Parser.*parse_|::parse_[A-Z]|::[A-Z]\w*?_(pre|post|nud|bp|bin|led)\b/.test(sym)) return 'rule-function symbols';
  if (/Parser/.test(sym)) return 'Parser helper symbols';
  if (/CstBuilder|Builder/.test(sym)) return 'builder symbols';
  if (/RawVec|grow|reserve|finish_grow|alloc::/.test(sym)) return 'alloc/RawVec symbols';
  if (/drop_in_place/.test(sym)) return 'drop symbols';
  return 'other symbols';
}

function oxcClass(file: string, sym: string): string {
  const m = /\/(oxc[a-z_]*)-\d+\.\d+\.\d+\/src\/([^/]+)/.exec(file);
  if (m) {
    const [, crate, sub] = m;
    if (crate === 'oxc_parser') {
      if (sub === 'lexer') return 'oxc_parser lexer (src/lexer)';
      if (sub === 'js' || sub === 'ts' || sub === 'jsx') return 'oxc_parser grammar (src/js, src/ts, src/jsx)';
      return `oxc_parser engine (src/${sub})`;
    }
    if (crate === 'oxc_ast') return `oxc_ast (${sub}: AST constructors)`;
    if (crate === 'oxc_allocator') return `oxc_allocator (${sub}: bump arena, arena Vec/Box)`;
    return `${crate} (${sub})`;
  }
  if (/\/src\/bin\/oxc-once\.rs|oxc-lex\/src/.test(file)) return 'driver';
  return '';
}
function oxcSymClass(sym: string): string {
  if (/oxc_parser::lexer|Lexer</.test(sym)) return 'lexer symbols';
  if (/oxc_parser/.test(sym)) return 'parser symbols';
  if (/oxc_allocator|bump|Arena/.test(sym)) return 'allocator symbols';
  if (/oxc_ast/.test(sym)) return 'ast symbols';
  if (/oxc_regular_expression/.test(sym)) return 'regex symbols';
  if (/oxc_prof_/.test(sym)) return 'driver';
  return 'other symbols';
}

const phase = new Map<string, number>();
const srcFn = new Map<string, number>();
const sym = new Map<string, number>();
const matrix = new Map<string, number>();
const stdBy = new Map<string, number>();
let owners: Owner[] = [], lexEnd = 0, mainBase = '';
if (kind === 'mono') {
  const text = readFileSync(mainRs, 'utf8');
  owners = ownersOf(text);
  lexEnd = text.split('\n').findIndex((l) => l.startsWith('const RULE_NAMES')) + 1;
  mainBase = 'src/main.rs';
}
for (const c of costs) {
  add(sym, c.fn, c.ir);
  const lc = libcClass(c.fn);
  if (lc && !isStd(c.file) && !/main\.rs$/.test(c.file)) { add(phase, lc, c.ir); add(srcFn, `[libc] ${c.fn}`, c.ir); continue; }
  if (kind === 'mono') {
    const sc = monoSymClass(c.fn);
    if (c.file.endsWith(mainBase)) {
      const o = owners[c.line] || { fn: '?', ctx: '' };
      const cl = monoClass(o, c.line, lexEnd);
      add(phase, cl, c.ir);
      add(srcFn, `${o.ctx ? o.ctx.replace(/^impl(<[^>]*>)? /, '') + '::' : ''}${o.fn}`, c.ir);
      add(matrix, `${cl}  <in>  ${sc}`, c.ir);
    } else if (isStd(c.file)) {
      add(phase, `std inlined into ${sc}`, c.ir);
      add(stdBy, `${sc} <- ${stdShort(c.file)}`, c.ir);
      add(srcFn, `[std] ${stdShort(c.file)}`, c.ir);
    } else {
      add(phase, `no line info / other object (${sc})`, c.ir);
      add(srcFn, `[sym] ${c.fn}`, c.ir);
    }
  } else {
    const sc = oxcSymClass(c.fn);
    const cl = oxcClass(c.file, c.fn);
    if (cl) {
      add(phase, cl, c.ir);
      add(srcFn, `${c.file.replace(/^.*\/(oxc[a-z_]*-\d+\.\d+\.\d+\/)/, '$1')} [in ${c.fn.replace(/<[^<>]*(<[^<>]*>[^<>]*)*>/g, '<>').slice(0, 90)}]`, c.ir);
      add(matrix, `${cl}  <in>  ${sc}`, c.ir);
    } else if (isStd(c.file)) {
      add(phase, `std inlined into ${sc}`, c.ir);
      add(stdBy, `${sc} <- ${stdShort(c.file)}`, c.ir);
      add(srcFn, `[std] ${stdShort(c.file)}`, c.ir);
    } else {
      add(phase, `no line info / other object (${sc})`, c.ir);
      add(srcFn, `[sym] ${c.fn}`, c.ir);
    }
  }
}
console.log(`REGIONS ${kind} ${cgFile}`);
console.log(`total Ir (callgrind totals) ${fmt(total)}; sum of self costs read ${fmt(selfSum)}`);
table('Ir by phase (self cost by source location; inlined code counted where it was written)', phase, 100);
table(`top ${TOP} source-level owners (self cost, inlined code included)`, srcFn);
table(`top ${TOP} symbols (machine-code functions, self cost)`, sym);
table('std-library code inlined, by symbol class and std file', stdBy, 25);
table('phase <in> symbol class (where inlined code from each phase executes)', matrix, 30);
