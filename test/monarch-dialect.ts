// monarch-dialect.ts — what the Monarch generator does for an element region (docs/REGIONS.md),
// the Monarch counterpart of test/tm-dialect.ts.
//
// Monaco is not run headless here; `tokenize` below runs the Monarch rule subset gen-monarch emits
// as Monaco's lexer runs it (per line, rules tried in order anchored at the cursor, `include`
// expanded, `cases` dispatched on the matched text, one action per capture group, `next` /
// `switchTo` / `@pop` on a state stack that persists across lines, a zero-width match only with a
// state change, `@rematch`, an embedded language from `nextEmbedded` up to its state's `@pop`
// rule). Monaco's own tokenizer is not run: these rows are the repo's runner's reading.
//
// Sections:
//   1. JSX / TSX: rows on the COMMITTED `javascriptreact.monarch.json` / `typescriptreact.monarch.json`,
//      and a cross-check against the interpreter's token stream: every token of the region's own
//      kinds (text, close tag, self-close, tag tokens) gets the Monarch token of its kind.
//   2. DIALECTS: rows on the Monarch generated in memory for test/fixtures/elementdialect.ts and
//      test/fixtures/textdialect.ts, mirroring tm-dialect's rows where Monarch can express them.
//   2b. HTML: rows on the COMMITTED `html.monarch.json` (tags, attributes, comments, raw-text bodies).
//   3. MONACO-COMPILE: the static checks of Monaco's Monarch compiler on every Monarch grammar.
// Every row states the behaviour WANTED; `xfail` marks a row the generator does not meet yet, with
// its reason. The gate fails when a `pass` row fails AND when an `xfail` row passes.
//   node test/monarch-dialect.ts           run, print failures and the counts
//   node test/monarch-dialect.ts --all     print every row with the token it saw
//   node test/monarch-dialect.ts --agreement [--write]   TextMate against Monarch on real code, by
//                                          class, against test/tm-monarch-agreement.json (tier ci)
import { readFileSync } from 'node:fs';
import { generateMonarch, type MonarchLanguage, type MonarchRule, type MonarchAction } from '../src/gen-monarch.ts';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import tsx from '../typescriptreact.ts';
import jsx from '../javascriptreact.ts';
import elementDialect from './fixtures/elementdialect.ts';
import textDialect from './fixtures/textdialect.ts';
import { tokenize, type Tok } from './monarch-tokenize.ts';

// --agreement: TextMate against Monarch on real code, by class (test/tm-monarch-agreement.ts).
if (process.argv.includes('--agreement')) process.exit(await (await import('./tm-monarch-agreement.ts')).agreement());


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
  const rsrc = 'component C() {\n  <a><style>.a { color: red; }</style><b/></a>\n}';
  tokRow('a `<style>` body is embedded CSS (rawText, code children)', 'pass', undefined, mon, rsrc, 'color', 0, is('embedded.css'));
  tokRow('after the raw element the children are code again', 'pass', undefined, mon, rsrc, 'b/>', 0, is('tag'));
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
  tokRow('`/* note */` in text is a comment (textTokens)', 'pass', undefined, mon, lsrc, 'note', 0, is('comment'));
  // text tokens (`textTokens`): tried before the text run; a run stops before one, `//` only
  // right after a blank (its `after` class) inside a run, anywhere at a run's start
  const tsrc = [
    'component Page() {',
    '  <main>a /* note */ b a//b x // tail',
    // a line comment in text runs to the end of the line, over a close tag too
    '    <p>// lead </p> still the comment',
    '    </p><p>{q}// hole',
    '    </p><p>/* c */// both',
    '    </p>',
    '    <p>see https://x.y and 1 <-// not a tag</p>',
    '    <p>m /* one',
    '      two */ after</p>',
    '  </main>',
    '}',
  ].join('\n');
  tokRow('a block comment in a text run', 'pass', undefined, mon, tsrc, 'note', 0, is('comment'));
  tokRow('text after a block comment', 'pass', undefined, mon, tsrc, ' b', 0, is(''));
  tokRow('`a//b` is text (`//` only after a blank)', 'pass', undefined, mon, tsrc, '//b', 0, is(''));
  tokRow('`x // tail`: `//` after a blank is a line comment', 'pass', undefined, mon, tsrc, 'tail', 0, is('comment'));
  tokRow('`//` at the start of the children is a line comment', 'pass', undefined, mon, tsrc, 'lead', 0, is('comment'));
  tokRow('a line comment in text runs to the end of the line, over `</p>`', 'pass', undefined, mon, tsrc, 'still', 0, is('comment'));
  tokRow('the close tag on the line after a line comment in text', 'pass', undefined, mon, tsrc, '</p>', 1, is('delimiter.tag'));
  tokRow('`//` right after a hole is a line comment (a new run)', 'pass', undefined, mon, tsrc, 'hole', 0, is('comment'));
  tokRow('`//` right after a block comment is a line comment', 'pass', undefined, mon, tsrc, 'both', 0, is('comment'));
  tokRow('`https://x.y` is text', 'pass', undefined, mon, tsrc, '//x', 0, is(''));
  tokRow('`<-//`: a `<` that opens no tag is text, and `//` with no blank before it too', 'pass', undefined, mon, tsrc, '// not', 0, is(''));
  tokRow('a block comment over lines in text', 'pass', undefined, mon, tsrc, 'two', 0, is('comment'));
  tokRow('text after a block comment over lines', 'pass', undefined, mon, tsrc, 'after', 0, is(''));
  tokRow('an unterminated `/*` in text is text', 'xfail', 'a block comment is a pushed state: an unterminated `/*` runs to the next `*/` or the end of the file (the lexer finds no end, so it is text)', mon, 'component C() {\n  <p>a /* b</p>\n  <p>c</p>\n}', 'c</p>', 0, is(''));
  // the interpreter's stream drops skipped tokens: a comment is a non-blank unit between two
  // tokens (in this source every other unit, text included, is in a token)
  rows.push({ section, id: 'the units the interpreter skips as comments are exactly the Monarch comments', status: 'pass', check: () => {
    const lex = createParser(textDialect).tokenize(tsrc) as { type: string; text: string; offset: number }[];
    const skipped = new Set<number>();
    let at = 0;
    for (const t of [...lex, { offset: tsrc.length, text: '' }]) {
      for (let i = at; i < t.offset; i++) if (!/\s/.test(tsrc[i])) skipped.add(i);
      at = Math.max(at, t.offset + t.text.length);
    }
    const commented = new Set<number>();
    for (const x of tokenize(mon(), tsrc)) if (x.token === 'comment') for (let i = 0; i < x.text.length; i++) if (!/\s/.test(x.text[i])) commented.add(x.start + i);
    const only = (a: Set<number>, b: Set<number>) => [...a].filter(i => !b.has(i));
    const show = (xs: number[]) => xs.length ? JSON.stringify(xs.map(i => tsrc[i]).join('')) : '';
    const missing = only(skipped, commented), extra = only(commented, skipped);
    const bad = [missing.length ? `not comments in Monarch: ${show(missing)}` : '', extra.length ? `comments only in Monarch: ${show(extra)}` : ''].filter(Boolean);
    return { ok: bad.length === 0 && skipped.size > 0, saw: bad.length ? bad.join('; ') : `${skipped.size} units` };
  } });
  tokRow('`@if` in children is a directive keyword', 'pass', undefined, mon, lsrc, '@if', 0, is('keyword'));
  // directives (derived: grammar-analysis.ts directivesOf): an opener and its required literals,
  // a head `( … )` that is code, a body that is children, continuations only after a body
  const dsrc = [
    'component Page(items) {',
    '  <main>',
    '    @if (items.length) { <b>yes</b> } @else { none }',
    '    @for (x of items) { <li>{x}</li> } @empty { empty }',
    '    @for await (y of q) { w }',
    '    say @iffy (q) and @if q (r) {zz}',
    '    a@if (k) { inner } tail',
    '    @if ({a}.a) { deep }',
    '    @if (b) { one }',
    '    @else if (c) { two }',
    '    @try { t } @catch (e) { c } @pending { p }',
    '    @{ const v = 1; }',
    '    <p>x @else { y }</p>',
    '    @if (s) { s1 } @elsewhere',
    '  </main>',
    '}',
  ].join('\n');
  const kw = is('keyword');
  tokRow('an opener `@if`', 'pass', undefined, mon, dsrc, '@if (items', 0, kw);
  tokRow('a directive head is code', 'pass', undefined, mon, dsrc, 'items.length', 0, is('identifier'));
  tokRow('an element in a directive body', 'pass', undefined, mon, dsrc, 'b>yes', 0, is('tag'));
  tokRow('a continuation `@else` after a body', 'pass', undefined, mon, dsrc, '@else', 0, kw);
  tokRow('a continuation body is children: `none` is text', 'pass', undefined, mon, dsrc, 'none', 0, is(''));
  tokRow('`@for` with a head', 'pass', undefined, mon, dsrc, '@for', 0, kw);
  tokRow('a hole in a directive body', 'pass', undefined, mon, dsrc, 'x}', 0, is('identifier'));
  tokRow('the continuation `@empty`', 'pass', undefined, mon, dsrc, '@empty', 0, kw);
  tokRow('the opener\'s required literal `await` (`@for await (`)', 'pass', undefined, mon, dsrc, 'await', 0, kw);
  tokRow('`@iffy (` is text: the opener ends at a word boundary', 'pass', undefined, mon, dsrc, '@iffy', 0, is(''));
  tokRow('`@if q` is text: `@if` needs its `(`', 'pass', undefined, mon, dsrc, '@if q', 0, is(''));
  tokRow('a hole after a plain `( … )` in text is a hole', 'pass', undefined, mon, dsrc, 'zz', 0, is('identifier'));
  tokRow('an opener inside a text run (`a@if (`)', 'pass', undefined, mon, dsrc, '@if (k', 0, kw);
  tokRow('text after a directive in a run', 'pass', undefined, mon, dsrc, 'tail', 0, is(''));
  tokRow('a `{` inside the head\'s parentheses is code, the body opens after the `)`', 'pass', undefined, mon, dsrc, 'deep', 0, is(''));
  tokRow('a continuation on the line after its body', 'pass', undefined, mon, dsrc, '@else if', 0, kw);
  tokRow('`if` after `@else` is a required literal', 'pass', undefined, mon, dsrc, 'if (c', 0, kw);
  tokRow('`@try` / `@catch` / `@pending`', 'pass', undefined, mon, dsrc, '@pending', 0, kw);
  tokRow('the `@catch` head is code', 'pass', undefined, mon, dsrc, 'e)', 0, is('identifier'));
  tokRow('a code block `@{ … }` is code', 'pass', undefined, mon, dsrc, 'const v', 0, kw);
  tokRow('`@else` not after a body is text', 'pass', undefined, mon, dsrc, '@else { y', 0, is(''));
  tokRow('`@elsewhere` after a body is text (a continuation ends at a word boundary)', 'pass', undefined, mon, dsrc, '@elsewhere', 0, is(''));
  tokRow('the close tag after the directives', 'pass', undefined, mon, dsrc, 'main>', 1, is('tag'));
  rows.push({ section, id: 'an opener `@if` is written `@@if` in its regex (Monaco reads `@name` as an attribute)', status: 'pass', check: () => {
    const all = Object.values(mon().tokenizer).flat().filter(Array.isArray).map(r => r[0] as string);
    const bare = all.filter(x => /(?<!@)@(?!@)\w/.test(x.replace(/@@/g, '')));
    const ok = bare.length === 0 && all.some(x => x.startsWith('@@if'));
    return { ok, saw: ok ? 'escaped' : `unescaped: ${bare.slice(0, 3).join(' | ')}` };
  } });
  tokRow('an opener and its required literal on two lines', 'xfail', 'the opener test is a lookahead, which sees one line', mon, 'component C() {\n  <p>@if\n  (x) { y }</p>\n}', '@if', 0, kw);
  rows.push({ section, id: 'the interpreter\'s directive keywords (`AtWord`) are exactly the Monarch `@` keywords', status: 'pass', check: () => {
    const lex = createParser(textDialect).tokenize(dsrc) as { type: string; text: string; offset: number }[];
    const want = lex.filter(t => t.text.startsWith('@')).map(t => `${t.offset}:${t.text}`);
    const saw = tokenize(mon(), dsrc).filter(t => t.token === 'keyword' && t.text.startsWith('@')).map(t => `${t.start}:${t.text}`);
    const ok = JSON.stringify(want) === JSON.stringify(saw);
    return { ok, saw: ok ? `${want.length} keywords` : `lexer ${want.join(' ')} | Monarch ${saw.join(' ')}` };
  } });
  tokRow('a `<style>` body is raw: its `{` opens no hole (rawText)', 'pass', undefined, mon, lsrc, '{ color', 0, t => t !== 'delimiter.bracket');
  // raw text (`rawText`): the body is the declared embed's language (`nextEmbedded`), up to the
  // first `</` + the tag name; `unlessBodyStarts` makes it children, over line breaks too
  const rsrc = [
    'component Page() {',
    '  <main>',
    '    <style>.a { color: red; }</style>',
    '    <style>{css}</style>',
    '    <style>',
    '      {late}</style>',
    '    <style>',
    '      .b { x: 1 }',
    '    </style>',
    '    <SCRIPT>if (a<b) { go() }</SCRIPT>',
    '    <style/> tail <style>a</STYLE>b</style>',
    '    <p>after</p>',
    '  </main>',
    '}',
  ].join('\n');
  const emb = (lang: string) => is(`embedded.${lang}`);
  tokRow('a `<style>` body is embedded CSS', 'pass', undefined, mon, rsrc, 'color', 0, emb('css'));
  tokRow('the `</style>` after a raw body is a close tag', 'pass', undefined, mon, rsrc, 'style', 1, is('tag'));
  tokRow('`<style>{css}`: the body starts with `{`, so it is a hole (unlessBodyStarts)', 'pass', undefined, mon, rsrc, 'css}', 0, is('identifier'));
  tokRow('unlessBodyStarts over a line break: `<style>`⏎`{late}` is a hole', 'pass', undefined, mon, rsrc, 'late', 0, is('identifier'));
  tokRow('a raw body on the lines after its open tag is embedded CSS', 'pass', undefined, mon, rsrc, '.b', 0, emb('css'));
  tokRow('the close tag on its own line after a multi-line raw body', 'pass', undefined, mon, rsrc, 'style', 7, is('tag'));
  tokRow('`<SCRIPT>` (any case: ignoreCase) body is embedded JS; its `<b` opens no element', 'pass', undefined, mon, rsrc, 'a<b', 0, emb('js'));
  tokRow('the `</SCRIPT>` close tag is a tag', 'pass', undefined, mon, rsrc, 'SCRIPT', 1, is('tag'));
  tokRow('a self-closing `<style/>` has no raw body: text after it', 'pass', undefined, mon, rsrc, 'tail', 0, is(''));
  tokRow('a raw body ends only at `</style` (exact case: `</STYLE>` is body)', 'pass', undefined, mon, rsrc, 'STYLE>b', 0, emb('css'));
  tokRow('children after the raw elements', 'pass', undefined, mon, rsrc, 'after', 0, is(''));
  // a declaration without an embed: the body is the raw token's own scope
  {
    let m2: MonarchLanguage | null = null;
    const el = textDialect.elements!;
    const plain = () => (m2 ??= generateMonarch({ ...textDialect, elements: { ...el, rawText: [{ tags: ['style'], token: 'StyleBody' }, ...el.rawText!.slice(1)] } } as CstGrammar));
    // the raw token's Monarch token, as the generator maps its scope (`meta.embedded.block.css`)
    const bodyTok = () => tokenAt(plain(), rsrc, '.a', 0).token;
    tokRow('without an embed a raw body is one token of the raw token\'s scope; its `{` opens no hole', 'pass', undefined, plain, rsrc, '{ color', 0, t => t === bodyTok() && !t.startsWith('embedded.') && t !== 'delimiter.bracket');
    tokRow('without an embed the close tag after the raw body is a tag', 'pass', undefined, plain, rsrc, 'style', 1, is('tag'));
  }
  rows.push({ section, id: 'every raw-text token of the interpreter\'s stream is embedded in Monarch', status: 'pass', check: () => {
    const lex = createParser(textDialect).tokenize(rsrc) as { type: string; text: string; offset: number }[];
    const mt = tokenize(mon(), rsrc);
    const bad: string[] = [];
    let n = 0;
    for (const t of lex) {
      if (t.type !== 'StyleBody' && t.type !== 'ScriptBody') continue;
      for (let k = 0; k < t.text.length; k++) {
        if (/\s/.test(t.text[k])) continue;
        n++;
        const at = t.offset + k;
        const m = mt.find(x => x.start <= at && at < x.start + x.text.length);
        if (!m || !m.token.startsWith('embedded.')) { bad.push(`${t.type} ${JSON.stringify(t.text)} at ${k} -> ${m ? m.token || "''" : 'none'}`); break; }
      }
    }
    const raw = mt.filter(x => x.token.startsWith('embedded.')).map(x => x.text).join('');
    const want = lex.filter(t => t.type === 'StyleBody' || t.type === 'ScriptBody').map(t => t.text.replace(/\s/g, '')).join('');
    if (raw.replace(/\s/g, '') !== want) bad.push(`Monarch embeds ${JSON.stringify(raw)}, the lexer's raw tokens are ${JSON.stringify(want)}`);
    return { ok: bad.length === 0 && n > 0, saw: bad.length ? bad.join('; ') : `${n} units` };
  } });
}

// ── 2b. HTML (the committed `html.monarch.json`, gen-monarch's markup path): tags, attributes,
// comments and raw-text bodies; a `<` inside `<script>` / `<!-- -->` is content, never a tag
// delimiter. A row holds when the tokenizer emits a token of exactly that text and that token.
{
  section = 'html';
  const mon = monOf('html.monarch.json');
  const has = (id: string, src: string, text: string, token: string, none = false) =>
    rows.push({ section, id, status: 'pass', check: () => {
      const toks = tokenize(mon(), src);
      const hit = toks.some(t => t.text === text && t.token === token);
      return { ok: hit !== none, saw: toks.map(t => `${JSON.stringify(t.text)}:${t.token || "''"}`).join(' ') };
    } });
  const div = '<div class="x">hi</div>';
  has('`<` of a tag is a delimiter', div, '<', 'delimiter');
  has('tag name `div`', div, 'div', 'tag');
  has('attribute name `class`', div, 'class', 'attribute.name');
  has('`=` of an attribute is a delimiter', div, '=', 'delimiter');
  has('attribute value `x` is a string', div, 'x', 'string');
  has('text content `hi` is the uncoloured root', div, 'hi', '');
  has('tag name of a self-closing `<br/>`', '<br/>', 'br', 'tag');
  has('`/>` is a delimiter', '<br/>', '/>', 'delimiter');
  has('attribute value `/y` is a string', '<a href="/y">', '/y', 'string');
  has('`<!--` opens a comment', '<!-- a < b -->', '<!--', 'comment');
  has('a `<` inside a comment is no delimiter', '<!-- a < b -->', '<', 'delimiter', true);
  has('tag name `script`', '<script>var a = 1 < 2;</script>', 'script', 'tag');
  has('the `<` of `1 < 2` in a `<script>` body is source.js, not a tag delimiter', '<script>var a = 1 < 2;</script>', '<', 'source.js');
  has('a `<style>` body is source.css', '<style>a > b{}</style>', 'a > b{}', 'source.css');
}

// ── 3. Monaco's compiler: the static checks its Monarch compiler (`monarchCompile.ts`) makes,
// re-stated (Monaco is not a dependency), on every committed Monarch grammar and both dialects:
// a regex's `@name` is replaced by the language attribute `name` (a string), else the compile
// throws (`@@` is a literal `@`); `next` and `include` name a defined state (or `@pop`, `@push`,
// `@popall`); a group action array has one action per capture group; every regex compiles with
// the language's flags.
function monacoCompileProblems(lang: MonarchLanguage): string[] {
  const states = lang.tokenizer;
  const attrs = lang as unknown as Record<string, unknown>;
  const bad: string[] = [];
  const exists = (s: string) => { let x: string | null = s.replace(/^@/, ''); while (x) { if (states[x]) return true; const i = x.lastIndexOf('.'); x = i < 0 ? null : x.slice(0, i); } return false; };
  const expand = (str: string) => {
    str = str.replace(/@@/g, '\x01');
    for (let n = 0, had = true; had && n < 5; n++) {
      had = false;
      str = str.replace(/@(\w+)/g, (_s, a: string) => { had = true; const v = attrs[a]; if (typeof v !== 'string') { bad.push(`/${str}/ references the attribute @${a}, which is ${v === undefined ? 'not defined' : `a ${typeof v}`}`); return ''; } return v ? `(?:${v})` : ''; });
    }
    return str.replace(/\x01/g, '@');
  };
  const checkAction = (a: unknown, where: string): void => {
    if (typeof a === 'string' || a == null) return;
    if (Array.isArray(a)) { a.forEach(x => checkAction(x, where)); return; }
    const o = a as Record<string, unknown>;
    if (o.cases) { for (const v of Object.values(o.cases as object)) checkAction(v, where); return; }
    const next = o.next as string | undefined;
    if (next && !/^@(pop|push|popall)$/.test(next) && !exists(next)) bad.push(`${where}: next ${next} is not a state`);
  };
  for (const [st, rules] of Object.entries(states)) for (const r of rules) {
    if (!Array.isArray(r)) { const inc = (r as { include: string }).include; if (!exists(inc)) bad.push(`${st}: include ${inc} is not a state`); continue; }
    const [reSrc, action, next] = r as [string, unknown, string?];
    let rx: RegExp;
    try { rx = new RegExp(`^(?:${expand(reSrc)})`, lang.ignoreCase ? 'i' : ''); } catch (e) { bad.push(`${st}: /${reSrc}/ does not compile: ${(e as Error).message}`); continue; }
    if (Array.isArray(action)) {
      const groups = new RegExp(`${rx.source}|`).exec('')!.length - 1;
      if (groups !== action.length) bad.push(`${st}: /${reSrc}/ has ${groups} groups, ${action.length} actions`);
    }
    checkAction(action, `${st} /${reSrc}/`);
    if (next) checkAction({ next }, `${st} /${reSrc}/`);
  }
  return bad;
}
section = 'monaco-compile';
for (const file of ['javascriptreact.monarch.json', 'typescriptreact.monarch.json', 'javascript.monarch.json', 'typescript.monarch.json', 'html.monarch.json', 'yaml.monarch.json'])
  rows.push({ section, id: `${file} passes Monaco's compile checks`, status: 'pass', check: () => { const b = monacoCompileProblems(JSON.parse(readFileSync(file, 'utf8'))); return { ok: !b.length, saw: b.join('; ') || 'clean' }; } });
for (const [name, g] of [['elementdialect', elementDialect], ['textdialect', textDialect]] as const)
  rows.push({ section, id: `the ${name} Monarch passes Monaco's compile checks`, status: 'pass', check: () => { const b = monacoCompileProblems(generateMonarch(g)); return { ok: !b.length, saw: b.join('; ') || 'clean' }; } });

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
