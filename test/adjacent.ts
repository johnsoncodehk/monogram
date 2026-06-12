// adjacent.ts — the `adjacent` zero-width assertion and the adjacency-aware tag-head
// TextMate emission, specified as engine behavior over a TOY Pug-like grammar (token
// names and selector characters deliberately unlike any real language — the behavior
// is grammar DATA, exactly like indent-extensions.ts).
//
// THE PROBLEM. An indentation "tag head" packs a tag name with GLUED `.class` selectors
// and a glued `(attr)` list — `el.cls(att)`. The lexer skips whitespace between tokens,
// so a gap is INVISIBLE to the grammar: `el .cls` parses `.cls` as a class and the flat
// token-soup highlighter scopes `.cls` (and any interior text) as a class/attr/tag. That
// is wrong — a space should break the head, leaving everything after it as plain text.
//
// THE CONTRACT. `adjacent` is a zero-width assertion (sibling of `sameLine`) that holds
// only when the next token starts exactly where the previous one ended — no skipped
// whitespace/comment. Used as `many(adjacent, Sel)` / `opt(adjacent, Attrs)` it makes the
// gap significant: glued selectors/attrs stay in the head; a space ejects them to text.
// gen-tm honors it by emitting a structured `begin`/`end` tag-head context (instead of
// flat token soup) that ends at the first whitespace.
//
// These tests assert the BEHAVIOR (parse membership + emitted TextMate scopes), not the
// implementation — a reimplementation must satisfy them. The `baseline` (no `adjacent`)
// cases pin down exactly what the feature changes.
import { token, rule, defineGrammar, alt, many, opt, seq, noneOf, range, plus, never, adjacent } from '../src/api.ts';
import type { IndentConfig } from '../src/types.ts';
import { createParser } from '../src/gen-parser.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { generateMonarch } from '../src/gen-monarch.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { cond ? ok++ : (fail++, console.log('  ✗', label)); };

// ── Toy grammar: `El(.Cls)*(Att…)? text` — built with or without the `adjacent` gates ──
const lower = range('a', 'z');
const Indent = token(never(), {}), Dedent = token(never(), {}), Newline = token(never(), {});
const El  = token(plus(lower), { blockOnly: true, scope: 'entity.name.tag' });
const Cls = token(seq('.', plus(lower)), { blockOnly: true, scope: 'entity.other.attribute-name.class' });
const Att = token(plus(lower), { scope: 'entity.other.attribute-name' });
const Txt = token(plus(noneOf(' ', '\t', '\n', '(', ')')), { blockOnly: true, scope: 'text' });
const base: IndentConfig = { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', flowOpen: ['('], flowClose: [')'] };

function mk(glued: boolean) {
  const Attrs = rule(() => [['(', many(Att), ')']]);
  const Text  = rule(() => [[many(alt(Txt, Cls, Att, '(', ')'))]]);
  const Head  = glued ? rule(() => [[El, many(adjacent, Cls)]]) : rule(() => [[El, many(Cls)]]);
  const Elem  = glued ? rule(() => [[Head, opt(adjacent, Attrs), opt(Text)]]) : rule(() => [[Head, opt(Attrs), opt(Text)]]);
  const Doc   = rule(() => [[opt(Elem)]]);
  return defineGrammar({ name: 'toy', tokens: { Indent, Dedent, Newline, El, Cls, Att, Txt }, rules: { Attrs, Text, Head, Elem, Doc }, entry: Doc, indent: base });
}
const gAdj = mk(true), gBase = mk(false);

// ── 1. Parser: a space ejects the selector / paren from the head ──
function membership(g: ReturnType<typeof defineGrammar>, src: string): string {
  const { parse } = createParser(g as any);
  let cst: any;
  try { cst = parse(src); } catch { return 'PARSE-ERROR'; }
  const out: string[] = [];
  (function walk(n: any, rl: string) {
    if (!n) return;
    if (n.tokenType) { out.push(`${rl}:${n.tokenType}`); return; }
    if (n.rule) for (const c of n.children) walk(c, n.rule);
  })(cst, 'root');
  return out.join(' ');
}
check('parser: glued `.cls` is inside the Head', membership(gAdj, 'el.cd').includes('Head:Cls'));
check('parser: spaced `.cls` is NOT in the Head (falls to Text)',
  !membership(gAdj, 'el .cd').includes('Head:Cls') && membership(gAdj, 'el .cd').includes('Text:Cls'));
check('parser: glued `(att)` parses as the attribute list', membership(gAdj, 'el(xy)').includes('Attrs:'));
check('parser: spaced `(att)` is NOT an attribute list', !membership(gAdj, 'el (xy)').includes('Attrs:'));
check('parser: chained glued classes all bind (`el.a.b`)',
  (membership(gAdj, 'el.a.b').match(/Head:Cls/g) ?? []).length === 2);
// Baseline: without `adjacent`, the gap is invisible — the bug the feature fixes.
check('parser baseline: without `adjacent`, spaced `.cls` is wrongly absorbed into the Head',
  membership(gBase, 'el .cd').includes('Head:Cls'));

// ── 2. TextMate emission: glued head scoped per-part; spaced → plain text ──
const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

async function scoper(g: ReturnType<typeof defineGrammar>) {
  const tm = generateTmLanguage(g as any, 'toy');
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async () => parseRawGrammar(JSON.stringify(tm), 'toy.json'),
  });
  const grammar = await reg.loadGrammar(tm.scopeName);
  if (!grammar) throw new Error('failed to load generated grammar');
  return (line: string, needle: string): string => {
    const r = grammar.tokenizeLine(line, INITIAL);
    const at = line.indexOf(needle);
    for (const t of r.tokens) if (at >= t.startIndex && at < t.endIndex) return t.scopes[t.scopes.length - 1];
    return '';
  };
}
const sAdj = await scoper(gAdj);
const sBase = await scoper(gBase);
const isClass = (s: string) => /attribute-name\.class/.test(s);
const isAttr  = (s: string) => /attribute-name(?!\.class)/.test(s);
const isTagOrSel = (s: string) => /entity\.name\.tag|attribute-name/.test(s);

check('tm: glued `el.cd(xy) hi` — `el` is a tag', /entity\.name\.tag/.test(sAdj('el.cd(xy) hi', 'el')));
check('tm: glued `.cd` is a class', isClass(sAdj('el.cd(xy) hi', '.cd')));
check('tm: glued `(xy)` attribute name is an attribute', isAttr(sAdj('el.cd(xy) hi', 'xy')));
check('tm: interior text after the head is NOT a tag/selector', !isTagOrSel(sAdj('el.cd(xy) hi', 'hi')));
check('tm: spaced `.cd` is NOT a class', !isClass(sAdj('el .cd hi', '.cd')));
check('tm: spaced `(xy)` content is NOT an attribute', !isAttr(sAdj('el (xy) hi', 'xy')));
// Baseline: the flat token-soup highlighter mis-scopes spaced selectors / interior text.
check('tm baseline: without `adjacent`, the flat highlighter mis-scopes a spaced `.cd` or interior text',
  isClass(sBase('el .cd hi', '.cd')) || isTagOrSel(sBase('el .cd hi', 'hi')));

// ── 3. tree-sitter: glued selectors become IMMEDIATE tokens (no whitespace before) ──
const tsAdj = (generateTreeSitter(gAdj as any, 'toy') as { grammarJs: string }).grammarJs;
const tsBase = (generateTreeSitter(gBase as any, 'toy') as { grammarJs: string }).grammarJs;
check('tree-sitter: a glued selector is emitted as token.immediate (forbids a leading space)',
  /token\.immediate\(\/\\\.\[a-z\]\+\/\)/.test(tsAdj));
check('tree-sitter baseline: without `adjacent`, the selector is a plain (space-permitting) token',
  !/token\.immediate/.test(tsBase));
// The glued attribute list opens with a dedicated IMMEDIATE flow token (the scanner emits it only
// when no whitespace precedes), so `el(x)` parses as an attr list and `el (x)` as text. Build-verified
// separately by parsing both forms; here we assert the structural emission.
check('tree-sitter: the glued attribute list opens with an immediate flow token',
  /_flow_lparen_immediate/.test(tsAdj));
check('tree-sitter baseline: without `adjacent`, the attribute list uses the plain flow token',
  !/_flow_lparen_immediate/.test(tsBase));

// ── 4. Monarch: glued head scoped per-part; spaced → plain text (faithful interpreter) ──
function monarchScoper(g: ReturnType<typeof defineGrammar>) {
  const mon = generateMonarch(g as any);
  // Resolve `{ include: '@state' }` rules (Monaco does; a flat filter would silently drop them).
  const rulesFor = (state: string, seen = new Set<string>()): [string, any, string?][] => {
    const out: [string, any, string?][] = [];
    for (const r of (mon.tokenizer[state] ?? []) as any[]) {
      if (Array.isArray(r)) out.push(r as [string, any, string?]);
      else if (r && r.include) { const s = (r.include as string).replace(/^@/, ''); if (!seen.has(s)) { seen.add(s); out.push(...rulesFor(s, seen)); } }
    }
    return out;
  };
  return (line: string, needle: string): string => {
    const stack = ['root'];
    const toks: { text: string; token: string }[] = [];
    let pos = 0, guard = 0;
    while (pos <= line.length) {
      if (++guard > 10000) break;
      const rules = rulesFor(stack[stack.length - 1]);
      let matched = false;
      for (const [re, act, third] of rules) {
        const m = new RegExp('^(?:' + re + ')').exec(line.slice(pos));
        if (!m) continue;
        const text = m[0];
        const token = typeof act === 'string' ? act : act.token;
        if (text.length > 0) toks.push({ text, token });
        const next = (typeof act === 'object' && (act.next ?? act.switchTo)) || third;
        const isSwitch = typeof act === 'object' && !!act.switchTo;
        if (next === '@pop') stack.pop();
        else if (next === '@popall') stack.splice(1);
        else if (typeof next === 'string' && next.startsWith('@')) { const t = next.slice(1); isSwitch ? (stack[stack.length - 1] = t) : stack.push(t); }
        pos += text.length;
        matched = true;
        if (text.length === 0 && !next) pos++;
        break;
      }
      if (!matched) pos++;
      if (pos > line.length) break;
    }
    let idx = 0; const at = line.indexOf(needle);
    for (const t of toks) { const e = idx + t.text.length; if (at >= idx && at < e) return t.token; idx = e; }
    return '';
  };
}
const mAdj = monarchScoper(gAdj), mBase = monarchScoper(gBase);
check('monarch: glued `el` → tag', mAdj('el.cd(xy) hi', 'el') === 'tag');
check('monarch: glued `.cd` → attribute.name', mAdj('el.cd(xy) hi', '.cd') === 'attribute.name');
check('monarch: glued `(xy)` name → attribute.name', mAdj('el.cd(xy) hi', 'xy') === 'attribute.name');
check('monarch: interior text after the head is the default token (not tag/attr)', mAdj('el.cd(xy) hi', 'hi') === '');
check('monarch: spaced `.cd` is the default token (not attribute.name)', mAdj('el .cd hi', '.cd') === '');
check('monarch: spaced `(xy)` content is the default token', mAdj('el (xy) hi', 'xy') === '');
// Over-fire guard: a tag-name-like word that is NOT line-leading (here, after a `(`) must not be
// taken as a tag — Monarch has no line-start anchor, so the head opens only via the per-line dispatch.
check('monarch: a tag-name word that is not line-leading is not a tag', mAdj('(zz) word', 'word') !== 'tag');
// Baseline: without `adjacent` there is no structured tag-head state — the feature adds the
// adjacency-aware highlighting (the flat path emits no head structure for these block tokens).
check('monarch baseline: without `adjacent`, no structured tag-head state is emitted',
  !('adj_taghead' in (generateMonarch(gBase as any) as { tokenizer: Record<string, unknown> }).tokenizer));
void mBase;

console.log(`  adjacent: ${ok} checks pass${fail ? `, ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
