// monarch-dialect.ts — what the Monarch generator does for an element region (docs/REGIONS.md),
// the Monarch counterpart of test/tm-dialect.ts.
//
// Monaco is not run headless here; `tokenize` below runs the Monarch rule subset gen-monarch emits
// as Monaco's lexer runs it (per line, rules tried in order anchored at the cursor, `include`
// expanded, `cases` dispatched on the matched text, one action per capture group, `next` /
// `switchTo` / `@pop` on a state stack that persists across lines, a zero-width match only with a
// state change).
//
// Sections:
//   1. JSX / TSX: rows on the COMMITTED `javascriptreact.monarch.json` / `typescriptreact.monarch.json`,
//      and a cross-check against the interpreter's token stream: every token of the region's own
//      kinds (text, close tag, self-close, tag tokens) gets the Monarch token of its kind.
//   2. DIALECTS: rows on the Monarch generated in memory for test/fixtures/elementdialect.ts and
//      test/fixtures/textdialect.ts, mirroring tm-dialect's rows where Monarch can express them.
// Every row states the behaviour WANTED; `xfail` marks a row the generator does not meet yet, with
// its reason. The gate fails when a `pass` row fails AND when an `xfail` row passes.
//   node test/monarch-dialect.ts           run, print failures and the counts
//   node test/monarch-dialect.ts --all     print every row with the token it saw
import { readFileSync } from 'node:fs';
import { generateMonarch, type MonarchLanguage, type MonarchRule, type MonarchAction } from '../src/gen-monarch.ts';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import tsx from '../typescriptreact.ts';
import jsx from '../javascriptreact.ts';
import elementDialect from './fixtures/elementdialect.ts';
import textDialect from './fixtures/textdialect.ts';

interface Tok { start: number; text: string; token: string }

function tokenize(mon: MonarchLanguage, src: string): Tok[] {
  const out: Tok[] = [];
  const stack: string[] = ['root'];
  const flags = mon.ignoreCase ? 'i' : '';
  const cache = new Map<string, RegExp>();
  const re = (s: string) => { let r = cache.get(s); if (!r) { r = new RegExp(`^(?:${s})`, flags); cache.set(s, r); } return r; };
  const rulesOf = (state: string, seen = new Set<string>()): [string, MonarchAction, string?][] => {
    const rs = mon.tokenizer[state];
    if (!rs) throw new Error(`no state \`${state}\``);
    const flat: [string, MonarchAction, string?][] = [];
    for (const r of rs) {
      if (!Array.isArray(r)) {
        const inc = (r as { include: string }).include.replace(/^@/, '');
        if (seen.has(inc)) throw new Error(`include cycle at \`${inc}\``);
        flat.push(...rulesOf(inc, new Set([...seen, inc])));
      } else flat.push(r as [string, MonarchAction, string?]);
    }
    return flat;
  };
  const resolve = (a: MonarchAction, text: string): MonarchAction => {
    if (typeof a === 'object' && !Array.isArray(a) && 'cases' in a) return resolve(a.cases[text] ?? a.cases['@default'] ?? '', text);
    return a;
  };
  let base = 0;
  for (const line of src.split('\n')) {
    let pos = 0;
    let guard = 0;
    while (pos < line.length) {
      if (++guard > 100000) throw new Error('Monarch runaway');
      const state = stack[stack.length - 1];
      let matched = false;
      for (const [reSrc, action0, third] of rulesOf(state)) {
        const m = re(reSrc).exec(line.slice(pos));
        if (!m) continue;
        const text = m[0];
        const action = resolve(action0, text);
        if (Array.isArray(action)) {
          if (m.length - 1 !== action.length) throw new Error(`rule /${reSrc}/: ${m.length - 1} groups, ${action.length} actions`);
          if (m.slice(1).join('') !== text) throw new Error(`rule /${reSrc}/: the groups do not cover the match`);
          let p = pos;
          for (let i = 0; i < action.length; i++) {
            const g = m[i + 1] ?? '';
            const a = resolve(action[i], g);
            if (g) out.push({ start: base + p, text: g, token: typeof a === 'string' ? a : (a as { token: string }).token });
            p += g.length;
          }
        } else {
          const token = typeof action === 'string' ? action : (action as { token: string }).token;
          if (text) out.push({ start: base + pos, text, token });
          const next = (typeof action === 'object' && ((action as { next?: string }).next)) || third;
          const sw = typeof action === 'object' ? (action as { switchTo?: string }).switchTo : undefined;
          const depth = stack.length;
          if (sw) stack[stack.length - 1] = sw.replace(/^@/, '');
          else if (next === '@pop') { if (stack.length > 1) stack.pop(); }
          else if (next === '@popall') stack.splice(1);
          else if (next) stack.push(next.replace(/^@/, ''));
          if (!text && depth === stack.length && stack[stack.length - 1] === state) throw new Error(`no progress in state \`${state}\` at ${JSON.stringify(line.slice(pos, pos + 20))} (rule /${reSrc}/)`);
        }
        pos += text.length;
        matched = true;
        break;
      }
      if (!matched) { out.push({ start: base + pos, text: line[pos], token: mon.defaultToken }); pos++; }
    }
    base += line.length + 1;
  }
  return out;
}

interface Row { section: string; id: string; status: 'pass' | 'xfail'; why?: string; check: () => { ok: boolean; saw: string } }
const rows: Row[] = [];
let section = '';
/** The Monarch token covering the `nth` occurrence of `at` in `src`. */
function tokenAt(mon: MonarchLanguage, src: string, at: string, nth = 0): Tok {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(at, from + 1); if (from < 0) throw new Error(`'${at}' #${nth} not in source`); }
  const t = tokenize(mon, src).find(t => t.start <= from && from < t.start + t.text.length);
  if (!t) throw new Error(`no token at '${at}'`);
  return t;
}
const tokRow = (id: string, status: Row['status'], why: string | undefined, mon: () => MonarchLanguage, src: string, at: string, nth: number, want: (tok: string) => boolean) =>
  rows.push({ section, id, status, why, check: () => { const t = tokenAt(mon(), src, at, nth); return { ok: want(t.token), saw: `${JSON.stringify(t.text)} ${t.token || "''"}` }; } });
const is = (k: string) => (t: string) => t === k;
// a `tagOpen` that opens no element (test it at the `<`: a component name and a type both read
// `type.identifier`)
const notTag = (t: string) => t !== 'delimiter.tag';

// ── 1. JSX / TSX (the committed artifacts) ──
const monOf = (file: string) => { let m: MonarchLanguage | null = null; return () => (m ??= JSON.parse(readFileSync(file, 'utf8'))); };
for (const [name, file, g] of [['jsx', 'javascriptreact.monarch.json', jsx], ['tsx', 'typescriptreact.monarch.json', tsx]] as const) {
  section = name;
  const mon = monOf(file);
  const src = [
    'const a = <div className="x" data-id=\'y\' {...rest}>hi {user.name} &amp; more</div>;',
    'const b = <Foo.Bar baz={1} />;',
    'const c = <svg:rect xlink:href="u"/>;',
    'const d = <>frag {cond && <b>bold</b>}</>;',
    'x = p < q > r;',
    'y = <i/> / 2;',
    'function f() { return <ul>',
    '  <li key={k}>item</li>',
    '</ul>; } // end',
    'const e = <a b=<c/> />;',
  ].join('\n');
  tokRow('tag name `div`', 'pass', undefined, mon, src, 'div', 0, is('tag'));
  tokRow('`<` opening an element is a tag delimiter', 'pass', undefined, mon, src, '<div', 0, is('delimiter.tag'));
  tokRow('attribute name `className`', 'pass', undefined, mon, src, 'className', 0, is('attribute.name'));
  tokRow('attribute name `data-id` (a joiner within the name)', 'pass', undefined, mon, src, '-id', 0, is('attribute.name'));
  tokRow('attribute string `"x"`', 'pass', undefined, mon, src, '"x"', 0, is('string'));
  tokRow('attribute string `\'y\'`', 'pass', undefined, mon, src, "'y'", 0, is('string'));
  tokRow('spread attribute `{...rest}`: `rest` is code', 'pass', undefined, mon, src, 'rest', 0, is('identifier'));
  tokRow('children text `hi`', 'pass', undefined, mon, src, 'hi ', 0, is(''));
  tokRow('a hole in children: `user` is code', 'pass', undefined, mon, src, 'user', 0, is('identifier'));
  tokRow('an entity `&amp;` in text (highlight.text)', 'pass', undefined, mon, src, 'amp', 0, is('constant'));
  tokRow('text after an entity', 'pass', undefined, mon, src, ' more', 0, is(''));
  tokRow('close tag `</`', 'pass', undefined, mon, src, '</div', 0, is('delimiter.tag'));
  tokRow('close tag name `div`', 'pass', undefined, mon, src, 'div', 1, is('tag'));
  tokRow('after an element the position is a value: `;` is a delimiter', 'pass', undefined, mon, src, ';', 0, t => t.startsWith('delimiter') && t !== 'delimiter.tag');
  tokRow('member tag `Foo.Bar`: `Foo` is an object', 'pass', undefined, mon, src, 'Foo', 0, is('identifier'));
  tokRow('member tag `Foo.Bar`: `Bar` is a component (highlight.tagName)', 'pass', undefined, mon, src, 'Bar', 0, is('type.identifier'));
  tokRow('namespace tag `svg:rect`: `svg` is the tag prefix', 'pass', undefined, mon, src, 'svg', 0, is('tag'));
  tokRow('namespace tag `svg:rect`: `rect`', 'pass', undefined, mon, src, 'rect', 0, is('tag'));
  tokRow('namespace attribute `xlink:href`', 'pass', undefined, mon, src, 'href', 0, is('attribute.name'));
  tokRow('self-close `/>`', 'pass', undefined, mon, src, '/>', 1, is('delimiter.tag'));
  tokRow('fragment `<>` text', 'pass', undefined, mon, src, 'frag', 0, is(''));
  tokRow('an element inside a hole inside a fragment', 'pass', undefined, mon, src, 'bold', 0, is(''));
  tokRow('`p < q > r` is a comparison, not a tag', 'pass', undefined, mon, src, '< q', 0, notTag);
  tokRow('after `<i/>` a `/` is division, not a regex', 'pass', undefined, mon, src, '/ 2', 0, t => t === 'operator' || t === 'delimiter');
  tokRow('`return <ul>`: an element after an expression-head keyword', 'pass', undefined, mon, src, 'ul', 0, is('tag'));
  tokRow('a nested element on the next line', 'pass', undefined, mon, src, 'li key', 0, is('tag'));
  tokRow('an attribute on a nested element on the next line', 'pass', undefined, mon, src, 'key', 0, is('attribute.name'));
  tokRow('a close tag on a third line', 'pass', undefined, mon, src, 'ul>', 1, is('tag'));
  tokRow('code after the element on its last line: a comment', 'pass', undefined, mon, src, 'end', 0, is('comment'));
  tokRow('an element as an attribute value (`b=<c/>`)', 'pass', undefined, mon, src, 'c/>', 0, is('tag'));
  tokRow('after an attribute-value element the tag goes on: `/>`', 'pass', undefined, mon, src, ' />', 0, t => t === 'delimiter.tag' || t === 'white');
  // What Monarch cannot express (docs/REGIONS.md, generator section): the wanted reading is the
  // lexer's; each row is expected to fail, with the reason.
  const lim = ['z = <p>{a <b}</p>;', 'y = x.new <b> c;'].join('\n');
  tokRow('in a hole, `a <b` after a value is a comparison', 'xfail', 'Monarch is single-mode inside a pushed frame (a hole): it does not track values there, so every `<` the vetoes allow opens an element', mon, lim, '<b}', 0, notTag);
  // TSX's Monarch reads `.new` as a member (a value), so its `<` opens no element there
  tokRow('after a member access, `new <b` opens no element', name === 'jsx' ? 'xfail' : 'pass', name === 'jsx' ? 'the base states read `new` as an expression-head keyword whatever precedes it (no member-access state)' : undefined, mon, lim, '<b> c', 0, notTag);
  if (name === 'tsx') {
    const tsrc = [
      'const g = <T,>(x: T) => x;',
      'const h = <Box<number> v={1}/>;',
      'type F = <T>(x: T) => T;',
      'type G = <T>(',
      '  x: T) => T;',
    ].join('\n');
    tokRow('generic arrow `<T,>(x: T) => x` is no element (typeParameters.head)', 'pass', undefined, mon, tsrc, '<T,', 0, notTag);
    tokRow('tag type arguments `<Box<number>`: `Box` is a component', 'pass', undefined, mon, tsrc, 'Box', 0, is('type.identifier'));
    tokRow('after tag type arguments, `v` is an attribute', 'pass', undefined, mon, tsrc, 'v=', 0, is('attribute.name'));
    tokRow('a type-position signature `<T>(x: T) => T` is no element (typeParameters.signature)', 'pass', undefined, mon, tsrc, '<T>(x', 0, notTag);
    tokRow('a signature whose group spans lines is no element', 'xfail', 'the signature veto is a lookahead, which sees one line', mon, tsrc, '<T>(', 1, notTag);
  }
  // cross-check: each token of the region's own kinds gets its kind's Monarch token
  const kinds = new Map<string, (t: string) => boolean>([
    [g.elements!.text!, is('')], [g.elements!.closeTag, is('delimiter.tag')], [g.elements!.selfClose, is('delimiter.tag')],
    ...(g.elements!.tagTokens ?? []).map(k => [k, is('string')] as [string, (t: string) => boolean]),
  ]);
  rows.push({ section, id: 'every region-own token of the interpreter\'s stream has its Monarch kind', status: 'pass', check: () => {
    const lex = createParser(g as CstGrammar).tokenize(src) as { type: string; text: string; offset: number }[];
    const mt = tokenize(mon(), src);
    const bad: string[] = [];
    let n = 0;
    for (const t of lex) {
      const want = kinds.get(t.type);
      if (!want) continue;
      // a Monarch token never holds a line break: test the token's first unit that is not one
      const k = [...t.text].findIndex(ch => ch !== '\n' && ch !== '\r');
      if (k < 0) continue;
      n++;
      const at = t.offset + k;
      const m = mt.find(x => x.start <= at && at < x.start + x.text.length);
      if (!m || !want(m.token)) bad.push(`${t.type} ${JSON.stringify(t.text)} -> ${m ? m.token || "''" : 'none'}`);
    }
    return { ok: bad.length === 0 && n > 0, saw: bad.length ? bad.join('; ') : `${n} tokens` };
  } });
}

// ── 2. the dialect fixtures (generated in memory) ──
{
  section = 'elementdialect';
  let m: MonarchLanguage | null = null;
  const mon = () => (m ??= generateMonarch(elementDialect));
  const src = 'component Card(item) {\n  <my-card on:click={item.open} title="x" {item}>\n    "kid" <b/>\n  </my-card>\n}';
  tokRow('custom-element tag name `my-card`', 'pass', undefined, mon, src, 'my-card', 0, is('tag'));
  tokRow('attribute `on:click`', 'pass', undefined, mon, src, 'click', 0, is('attribute.name'));
  tokRow('an attribute hole is code: `item`', 'pass', undefined, mon, src, 'item.open', 0, is('identifier'));
  tokRow('code children: a string child is a string', 'pass', undefined, mon, src, '"kid"', 0, is('string'));
  tokRow('a nested element in code children', 'pass', undefined, mon, src, 'b/>', 0, is('tag'));
  tokRow('the close tag', 'pass', undefined, mon, src, 'my-card', 1, is('tag'));
}
{
  section = 'textdialect';
  let m: MonarchLanguage | null = null;
  const mon = () => (m ??= generateMonarch(textDialect));
  // the dynamic tag is a child: after `</main>` the position is a value, so a `<` there is a
  // comparison for the lexer (and for Monarch)
  const src = 'component Page(items) {\n  const z = a <b;\n  <main class="m">Hello & 1 < 2 {items.length}\n    <{tag} id="d">dyn</{tag}>\n  </main>\n}';
  tokRow('a `<` after a value in code is a comparison', 'pass', undefined, mon, src, '<b;', 0, notTag);
  tokRow('tag name `main`', 'pass', undefined, mon, src, 'main', 0, is('tag'));
  tokRow('attribute `class`', 'pass', undefined, mon, src, 'class', 0, is('attribute.name'));
  tokRow('children text `Hello`', 'pass', undefined, mon, src, 'Hello', 0, is(''));
  tokRow('`<` before a blank in text is text (tagStart)', 'pass', undefined, mon, src, '< 2', 0, is(''));
  tokRow('a hole in text is code', 'pass', undefined, mon, src, 'items.length', 0, is('identifier'));
  tokRow('dynamic tag: the hole after `<` is code', 'pass', undefined, mon, src, 'tag}', 0, is('identifier'));
  tokRow('dynamic tag: its attribute', 'pass', undefined, mon, src, 'id=', 0, is('attribute.name'));
  tokRow('dynamic close tag', 'pass', undefined, mon, src, 'tag}>', 0, is('identifier'));
  // the region features of later landings (each its own step, docs/REGIONS.md "Owed")
  const lsrc = 'component Page() { <main>a /* note */ @if (x) { y } <style>.a { color: red; }</style></main> }';
  tokRow('`/* note */` in text is a comment (textTokens)', 'xfail', 'text tokens are not in the Monarch children yet', mon, lsrc, 'note', 0, is('comment'));
  tokRow('`@if` in children is a directive keyword', 'xfail', 'directives are not in the Monarch children yet', mon, lsrc, '@if', 0, is('keyword'));
  tokRow('a `<style>` body is raw: its `{` opens no hole (rawText)', 'xfail', 'raw text (`nextEmbedded`) is not in the Monarch element layer yet', mon, lsrc, '{ color', 0, t => t !== 'delimiter.bracket');
}

const all = process.argv.includes('--all');
let pass = 0, xfail = 0, regress = 0, flipped = 0;
for (const r of rows) {
  let res: { ok: boolean; saw: string };
  try { res = r.check(); } catch (e) { res = { ok: false, saw: `threw: ${(e as Error).message}` }; }
  if (r.status === 'pass') { if (res.ok) pass++; else { regress++; console.log(`  ✗ REGRESSION [${r.section}] ${r.id}\n      saw: ${res.saw}`); } }
  else if (res.ok) { flipped++; console.log(`  ✗ NOW PASSES (flip its mark to 'pass'): [${r.section}] ${r.id}\n      saw: ${res.saw}`); }
  else xfail++;
  if (all) console.log(`  ${r.status === 'pass' ? (res.ok ? 'pass ' : 'FAIL ') : (res.ok ? 'XPASS' : 'xfail')} [${r.section}] ${r.id}\n      saw: ${res.saw}${r.why && !res.ok ? `\n      why: ${r.why}` : ''}`);
}
for (const sec of [...new Set(rows.map(r => r.section))]) {
  const rs = rows.filter(r => r.section === sec);
  console.log(`${sec}: ${rs.filter(r => r.status === 'pass').length} pass rows, ${rs.filter(r => r.status === 'xfail').length} expected-fail rows`);
}
console.log(`\n${pass} pass, ${xfail} expected-fail, ${regress} regressed, ${flipped} newly passing (of ${rows.length} rows)${regress + flipped ? '' : ' ✓'}`);
if (regress + flipped) process.exit(1);
