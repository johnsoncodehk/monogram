// textmate-dialect.ts — what the TextMate generator does for an element dialect that is not React.
//
// Two parts, both measured on grammars defined in the repository (no committed artifact):
//   1. DIALECT rows: scope assertions on test/fixtures/elementdialect.ts (`@if` / `@each`
//      directive keywords next to an `@name` annotation token, directive regions, a dynamic
//      tag, shorthand attributes, a `<style>` raw-text body with a CSS embed).
//   2. AGNOSTIC rows: element syntax under rule names and conventions that are not JSX's
//      (no `JSX*` rules, a declared tag-name scope, no upper/lower-case convention, `"`-only
//      strings, no entities, no fragments; and a `[tag]…[/tag]` bracket syntax) must get its
//      vocabulary from the grammar, in the spirit of test/agnostic.ts.
//   3. PARSE rows: the interpreter (src/interpreter/interpreter.ts) parses the dialect source of part 1. The
//      fixture declares an element region with code children (docs/REGIONS.md), so these rows
//      gate the lexer's region frames on a grammar that is not JSX, beside the highlighter's.
//
// Every row states the behaviour WANTED. A row the generator does not meet yet is marked
// `xfail` with its reason and the editor-queue item expected to flip it. The gate fails when a
// `pass` row fails (a regression) AND when an `xfail` row passes (flip its mark in the same
// commit, so the record says what changed).
//   node test/textmate-dialect.ts           run, print failures and the counts
//   node test/textmate-dialect.ts --all     print every row with the scopes it saw
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { token, rule, defineGrammar, seq, oneOf, range, star, opt, many, alt, noneOf } from '../src/api.ts';
import { generateTmLanguage } from '../src/editor/gen-textmate.ts';
import { createParser } from '../src/interpreter/interpreter.ts';
import type { Grammar } from '../src/grammar/types.ts';
import dialect from './fixtures/elementdialect.ts';
import textDialect from './fixtures/textdialect.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

// An embedded grammar the dialect's `<style>` body should delegate to. A stub is enough: a
// row asks only whether the body lands under `source.css`.
const cssStub = { scopeName: 'source.css', patterns: [{ match: '[a-z-]+(?=\\s*:)', name: 'support.type.property-name.css' }] };
const jsStub = { scopeName: 'source.js', patterns: [{ match: '\\blet\\b', name: 'storage.type.js' }] };

async function load(g: Grammar) {
  const tm = generateTmLanguage(g);
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
    loadGrammar: async (sc: string) => sc === tm.scopeName ? parseRawGrammar(JSON.stringify(tm), 'g.json')
      : sc === 'source.css' ? parseRawGrammar(JSON.stringify(cssStub), 'css.json')
      : sc === 'source.js' ? parseRawGrammar(JSON.stringify(jsStub), 'js.json') : null,
  });
  const grammar = await reg.loadGrammar(tm.scopeName);
  if (!grammar) throw new Error(`failed to load ${tm.scopeName}`);
  return { tm, grammar };
}

/** The scope stack (root excluded) of the token covering the `nth` occurrence of `at` in `src`. */
function scopesAt(grammar: vsctm.IGrammar, src: string, at: string, nth = 0): string[] {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(at, from + 1); if (from < 0) throw new Error(`'${at}' #${nth} not in source`); }
  let st = INITIAL, base = 0;
  for (const line of src.split('\n')) {
    const r = grammar.tokenizeLine(line, st); st = r.ruleStack;
    if (from < base + line.length + 1) {
      const col = from - base;
      const t = r.tokens.find(t => t.startIndex <= col && col < t.endIndex)!;
      return t.scopes.slice(1);
    }
    base += line.length + 1;
  }
  throw new Error('unreachable');
}

interface Row { section: string; id: string; status: 'pass' | 'xfail'; why?: string; check: () => { ok: boolean; saw: string } }
const rows: Row[] = [];
let section = '';
const scopeRow = (id: string, status: Row['status'], why: string | undefined, g: vsctm.IGrammar, src: string, at: string, nth: number, want: (s: string[]) => boolean) =>
  rows.push({ section, id, status, why, check: () => { const s = scopesAt(g, src, at, nth); return { ok: want(s), saw: s.join(' ') }; } });
const inner = (s: string[]) => s[s.length - 1] ?? '';
const has = (prefix: string) => (s: string[]) => s.some(x => x === prefix || x.startsWith(prefix + '.'));

// ── 1. the dialect ──
const dialectSrc = [
  '@route @iffy',
  'component Card(item, show) {',
  '  @if (show) { <b/> } @else { "n" }',
  '  @each (y of item.list) { "z" }',
  '  <my-card on:click={item.open} title="x" {item}>',
  '    @if (show) {',
  '      <span>{item.name}</span>',
  '    } @else {',
  '      "none"',
  '    }',
  '    @each (x of item.list) { <li {x}>{x}</li> } @empty { "empty" }',
  '    <{item.tag} id="d">"dyn"</{item.tag}>',
  '    <style>.a { color: red; }</style>',
  '  </my-card>',
  '}',
].join('\n');
{
  section = 'dialect';
  const { grammar: g } = await load(dialect);
  const src = dialectSrc;
  scopeRow('annotation `@route` is an annotation', 'pass', undefined, g, src, '@route', 0, s => inner(s).startsWith('entity.name.function.decorator'));
  scopeRow('annotation `@iffy` is not the keyword `@if` (the keyword ends at a word boundary)', 'pass', undefined, g, src, 'fy', 0, s => inner(s).startsWith('entity.name.function.decorator'));
  scopeRow('`@if` at statement start is a keyword', 'pass', undefined, g, src, '@if', 1, s => inner(s).startsWith('keyword.control.conditional'));
  scopeRow('`@else` after `} ` is a keyword', 'pass', undefined, g, src, '@else', 0, s => inner(s).startsWith('keyword.control.conditional'));
  scopeRow('`@each` is a keyword', 'pass', undefined, g, src, '@each', 0, s => inner(s).startsWith('keyword.control.loop'));
  scopeRow('`of` inside a directive head is a keyword', 'pass', undefined, g, src, 'of item', 0, s => inner(s).startsWith('keyword.control.loop'));
  scopeRow('custom-element tag name `my-card`', 'pass', undefined, g, src, 'my-card', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('namespaced attribute name `on:click`', 'pass', undefined, g, src, 'click', 0, s => inner(s).startsWith('entity.other.attribute-name'));
  scopeRow('shorthand attribute `{item}` is an embedded expression', 'pass', undefined, g, src, '{item}', 0, has('meta.embedded.expression'));
  scopeRow('`@if` inside element children is a keyword', 'pass', undefined, g, src, '@if', 2, s => inner(s).startsWith('keyword.control.conditional'));
  scopeRow('`@empty` inside element children is a keyword', 'pass', undefined, g, src, '@empty', 0, s => inner(s).startsWith('keyword.control.loop'));
  scopeRow('`of` inside element children is a keyword', 'pass', undefined, g, src, 'of item', 1, s => inner(s).startsWith('keyword.control.loop'));
  // the `{` after `@if (show)` on the line after `<my-card …>` (occurrence 6: 0-3 are before the
  // element, 4 and 5 are its attribute holes)
  scopeRow('a directive region `{` in children is not an expression container', 'pass', undefined, g, src, '{', 6, s => !has('meta.embedded.expression')(s));
  scopeRow('control: an attribute hole `{` is an expression container', 'pass', undefined, g, src, '{', 4, has('meta.embedded.expression'));
  scopeRow('an element inside a directive region keeps tag scopes', 'pass', undefined, g, src, 'span', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('dynamic tag `<{…}` opens a tag', 'pass', undefined, g, src, '<{item.tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('attribute of a dynamic tag is an attribute name', 'pass', undefined, g, src, 'id=', 0, s => inner(s).startsWith('entity.other.attribute-name'));
  scopeRow('dynamic close tag `</{…}>` closes a tag', 'pass', undefined, g, src, '</{item.tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('`<style>` body is embedded CSS', 'pass', undefined, g, src, 'color', 0, has('source.css'));
  scopeRow('the `</style>` close tag is a tag, outside the embed', 'pass', undefined, g, src, 'style', 1, s => inner(s).startsWith('entity.name.tag') && !has('source.css')(s));
  scopeRow('after the raw element the children are code again', 'pass', undefined, g, src, 'my-card', 1, s => inner(s).startsWith('entity.name.tag') && !has('source.css')(s));
}

// ── 1b. the TEXT dialect (test/fixtures/textdialect.ts): text children, tag start, text tokens,
//        directives, raw `<script>` (any case) and `<style>` unless its body starts with `{` ──
// Each row is read from the fixture grammar's own rules and region declaration.
const textSrc = [
  'component Page(items) {',
  '  const z = a <b;',
  '  <main class="m">Hello & 1 < 2 {items.length} /* note */ a//b // tail',
  '    @if (items.length) { <b>yes</b> } @else { none }',
  '    @for (x of items) { <li>{x}</li> } @empty { empty }',
  '    say @iffy (q) and @if q (r) {zz}',
  '    <style>{css}</style>',
  '    <style>.a { color: red; }</style>',
  '    <SCRIPT>let a = 1;</SCRIPT>',
  '    <{tag} id="d">dyn</{tag}>',
  '  </main>',
  '}',
].join('\n');
{
  section = 'textdialect';
  const { grammar: g } = await load(textDialect);
  const src = textSrc;
  const noTag = (s: string[]) => !s.some(x => x.startsWith('entity.name.tag') || x.startsWith('punctuation.definition.tag'));
  scopeRow('a `<` after a value in code is a comparison, not a tag', 'pass', undefined, g, src, 'b;', 0, noTag);
  scopeRow('tag name `main`', 'pass', undefined, g, src, 'main', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('attribute name `class`', 'pass', undefined, g, src, 'class', 0, s => inner(s).startsWith('entity.other.attribute-name'));
  scopeRow('attribute string `"m"` is a string', 'pass', undefined, g, src, 'm"', 0, has('string.quoted'));
  scopeRow('children text `Hello` is text, not code', 'pass', undefined, g, src, 'Hello', 0, s => !s.some(x => x.startsWith('variable')));
  scopeRow('`&` in text is no operator', 'pass', undefined, g, src, '&', 0, s => !s.some(x => x.startsWith('keyword')));
  scopeRow('`<` before a blank in text is text, not a tag (tagStart)', 'pass', undefined, g, src, '< 2', 0, noTag);
  scopeRow('a hole in text is an embedded expression', 'pass', undefined, g, src, 'length}', 0, has('meta.embedded.expression'));
  scopeRow('`/* note */` in text is a block comment (textTokens)', 'pass', undefined, g, src, 'note', 0, has('comment.block'));
  scopeRow('`a//b` in text is text (`//` only after a blank)', 'pass', undefined, g, src, '//b', 0, s => !has('comment')(s));
  scopeRow('`// tail` after a blank is a line comment (textTokens, `after`)', 'pass', undefined, g, src, 'tail', 0, has('comment.line'));
  scopeRow('`@if` in children is a directive keyword', 'pass', undefined, g, src, '@if', 0, s => inner(s).startsWith('keyword.control'));
  scopeRow('the `@if` head is code: `items` is a variable', 'pass', undefined, g, src, 'items.length)', 0, s => s.some(x => x.startsWith('variable')));
  scopeRow('`@else` continuation is a keyword', 'pass', undefined, g, src, '@else', 0, s => inner(s).startsWith('keyword.control'));
  scopeRow('an `@else` body is children: `none` is text', 'pass', undefined, g, src, 'none', 0, s => !s.some(x => x.startsWith('variable')));
  scopeRow('an element in a directive body keeps tag scopes', 'pass', undefined, g, src, 'b>yes', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('`of` in an `@for` head is a keyword', 'pass', undefined, g, src, 'of items', 0, s => inner(s).startsWith('keyword.control'));
  scopeRow('`@iffy (` is text: the opener ends at a word boundary', 'pass', undefined, g, src, '@iffy', 0, s => !s.some(x => x.startsWith('keyword')));
  scopeRow('`@if q` is text: `@if` needs its `(`', 'pass', undefined, g, src, '@if q', 0, s => !s.some(x => x.startsWith('keyword')));
  scopeRow('a hole after a plain `( … )` in text is a hole, not a directive body', 'pass', undefined, g, src, 'zz', 0, has('meta.embedded.expression'));
  scopeRow('`@empty` continuation is a keyword', 'pass', undefined, g, src, '@empty', 0, s => inner(s).startsWith('keyword.control'));
  scopeRow('`<style>{css}`: the body starts with `{`, so it is a hole (unlessBodyStarts)', 'pass', undefined, g, src, 'css}', 0, s => has('meta.embedded.expression')(s) && !has('source.css')(s));
  scopeRow('`<style>.a {…}` body is embedded CSS', 'pass', undefined, g, src, 'color', 0, has('source.css'));
  scopeRow('`<SCRIPT>` (any case) body is embedded JS', 'pass', undefined, g, src, 'let', 0, has('source.js'));
  scopeRow('the `</SCRIPT>` close tag is a tag', 'pass', undefined, g, src, 'SCRIPT', 1, s => inner(s).startsWith('entity.name.tag') && !has('source.js')(s));
  scopeRow('dynamic tag `<{tag}` opens a tag', 'pass', undefined, g, src, '<{tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('dynamic close tag `</{tag}>` closes a tag', 'pass', undefined, g, src, '</{tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('`</main>` closes the element', 'pass', undefined, g, src, 'main', 1, s => inner(s).startsWith('entity.name.tag'));
  rows.push({ section, id: 'the text dialect source parses', status: 'pass', check: () => { try { createParser(textDialect).parse(textSrc); return { ok: true, saw: 'parsed' }; } catch (e) { return { ok: false, saw: (e as Error).message.slice(0, 100) }; } } });
}

// ── 2. agnostic element syntax ──
{
  section = 'agnostic';
  // Angle-bracket elements, but the rules are named Markup / Widget / Label / Prop, every tag
  // name is declared `entity.name.tag` (no upper / lower-case convention), strings are `"`
  // only, there are no character entities and no fragments, and attribute names are dotted.
  const Name = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9')))), { identifier: true });
  const Quoted = token(seq('"', star(noneOf('"')), '"'), { string: true, scope: 'string.quoted.double' });
  const EndOpen = token(seq('<', '/'));
  const EmptyEnd = token(seq('/', '>'));
  const Label = rule(() => [[Name]]);
  const Prop = rule(() => [[Name, many('.', Name), '=', Quoted]]);
  const Widget = rule(($) => [
    ['<', Label, many(Prop), EmptyEnd],
    ['<', Label, many(Prop), '>', many(alt($, Quoted)), EndOpen, Label, '>'],
  ]);
  const Markup = rule(() => [many(Widget)]);
  const angle = defineGrammar({
    name: 'anglemarkup', scopeName: 'source.anglemarkup',
    tokens: { Name, Quoted, EndOpen, EmptyEnd },
    contextualScopes: [{ token: Name, within: Label, scope: 'entity.name.tag' }],
    // the element region, declared (a grammar that declares none gets no element layer); the
    // hole is declared because a region has one, and no rule uses it
    elements: { tagOpen: '<', tagClose: '>', closeMarker: '/', closeTag: 'EndOpen', selfClose: 'EmptyEnd', hole: { open: '{', close: '}' } },
    rules: { Label, Prop, Widget, Markup },
  });
  const { tm, grammar: g } = await load(angle);
  const src = '<Panel/>\n<row data.key="k">"text"</row>';
  scopeRow('capitalised tag `Panel` takes the declared `entity.name.tag`, not React\'s component scope', 'pass', undefined, g, src, 'Panel', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('lowercase tag `row` is `entity.name.tag` (from the declaration)', 'pass', undefined, g, src, 'row', 0, s => inner(s).startsWith('entity.name.tag'));
  for (const part of ['data', '.', 'key'])
    scopeRow(`dotted attribute name \`data.key\`: \`${part}\` is part of the attribute name`, 'pass', undefined, g, src, part === '.' ? '.key' : part, 0, s => has('entity.other.attribute-name')(s));
  scopeRow('element children are not scoped `meta.jsx.*` in a grammar with no JSX rule', 'pass', undefined, g, src, '"text"', 0, s => !s.some(x => x.includes('.jsx.')));
  const repoRow = (id: string, test: (keys: string[], json: string) => boolean) =>
    rows.push({ section, id, status: 'pass', check: () => { const keys = Object.keys(tm.repository); const json = JSON.stringify(tm); return { ok: test(keys, json), saw: keys.filter(k => k.includes('jsx')).join(' ') || '(none)' }; } });
  repoRow('repository keys carry the region\'s name, the grammar\'s (no `jsx-*` keys)', keys => !keys.some(k => k.startsWith('jsx')));
  repoRow('no single-quoted attribute string: the grammar\'s only string token is `"…"`', keys => !keys.some(k => /single-quoted/.test(k)));
  repoRow('no character-entity pattern: the grammar declares no entities', keys => !keys.some(k => /entity/.test(k)));
  repoRow('no fragment `<>` pattern: no rule has `<` directly followed by `>`', keys => !keys.some(k => /fragment/.test(k)));

  // The same element structure with `[tag …]…[/tag]` brackets: the tag-name scope is declared,
  // so it must reach the tag name whatever the delimiters.
  const BName = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });
  const BQuoted = token(seq('"', star(noneOf('"')), '"'), { string: true, scope: 'string.quoted.double' });
  const BClose = token(seq('[', '/'));
  const BSolo = token(seq('/', ']'));
  const BTag = rule(() => [[BName]]);
  const BElem = rule(($) => [['[', BTag, BSolo], ['[', BTag, ']', many(alt($, BQuoted)), BClose, BTag, ']']]);
  const BDoc = rule(() => [many(BElem)]);
  const bracket = defineGrammar({
    name: 'bracketmarkup', scopeName: 'source.bracketmarkup',
    tokens: { BName, BQuoted, BClose, BSolo },
    contextualScopes: [{ token: BName, within: BTag, scope: 'entity.name.tag' }],
    elements: { tagOpen: '[', tagClose: ']', closeMarker: '/', closeTag: 'BClose', selfClose: 'BSolo', hole: { open: '{', close: '}' } },
    rules: { BTag, BElem, BDoc },
  });
  const { grammar: bg } = await load(bracket);
  const bsrc = '[note]"hi"[/note]';
  scopeRow('`[note]`: the declared tag-name scope reaches a bracket-delimited tag', 'pass', undefined, bg, bsrc, 'note', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('`[/note]`: the declared tag-name scope reaches the close tag', 'pass', undefined, bg, bsrc, 'note', 1, s => inner(s).startsWith('entity.name.tag'));

  // Name joiners: what a joiner means comes from the grammar. A prefix joiner only when the
  // region declares it (`highlight.nameJoiners`), a member accessor only when it is one of the
  // grammar's `memberAccessTexts` (this toy has no regexContext), else it joins within one name.
  const JName = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });
  const JClose = token(seq('<', '/'));
  const JSolo = token(seq('/', '>'));
  const JTag = rule(() => [[JName, many(alt('.', ':'), JName)]]);
  const JAttr = rule(() => [[JName, opt(':', JName)]]);
  const JElem = rule(() => [['<', JTag, many(JAttr), JSolo]]);
  const JDoc = rule(() => [many(JElem)]);
  const joinerGrammar = (nameJoiners?: { text: string; scope: string; prefix: string }[]) => defineGrammar({
    name: 'joinmarkup', scopeName: 'source.joinmarkup',
    tokens: { JName, JClose, JSolo },
    elements: { tagOpen: '<', tagClose: '>', closeMarker: '/', closeTag: 'JClose', selfClose: 'JSolo', hole: { open: '{', close: '}' }, ...nameJoiners ? { highlight: { nameJoiners } } : {} },
    rules: { JTag, JAttr, JElem, JDoc },
  });
  const jsrc = '<svg:rect xlink:href/>\n<a.b/>';
  const { grammar: jPlain } = await load(joinerGrammar());
  scopeRow('no `nameJoiners`: `svg` in `svg:rect` is part of the tag name, not a namespace', 'pass', undefined, jPlain, jsrc, 'svg', 0, s => inner(s).startsWith('entity.name.tag') && !inner(s).includes('namespace'));
  scopeRow('no `nameJoiners`: `xlink` in `xlink:href` is part of the attribute name', 'pass', undefined, jPlain, jsrc, 'xlink', 0, s => inner(s).startsWith('entity.other.attribute-name') && !inner(s).includes('namespace'));
  scopeRow('no `memberAccessTexts`: `a` in `a.b` is part of the tag name, not an object', 'pass', undefined, jPlain, jsrc, 'a.b', 0, s => inner(s).startsWith('entity.name.tag'));
  const { grammar: jNs } = await load(joinerGrammar([{ text: ':', scope: 'punctuation.separator.ns', prefix: 'ns' }]));
  scopeRow('declared `:` joiner: `svg` is the tag name\'s prefix (`entity.name.tag.ns`)', 'pass', undefined, jNs, jsrc, 'svg', 0, s => inner(s).startsWith('entity.name.tag.ns'));
  scopeRow('declared `:` joiner: the `:` takes the declared scope', 'pass', undefined, jNs, jsrc, ':rect', 0, s => inner(s).startsWith('punctuation.separator.ns'));
  scopeRow('declared `:` joiner: `xlink` is the attribute name\'s prefix', 'pass', undefined, jNs, jsrc, 'xlink', 0, s => inner(s).startsWith('entity.other.attribute-name.ns'));
  scopeRow('declared `:` joiner: `rect` is the tag name', 'pass', undefined, jNs, jsrc, 'rect', 0, s => inner(s).startsWith('entity.name.tag') && !inner(s).includes('.ns'));
  const throwsRow = (id: string, f: () => unknown, want: RegExp) => rows.push({ section, id, status: 'pass', check: () => { try { f(); return { ok: false, saw: 'did not throw' }; } catch (e) { const m = (e as Error).message; return { ok: want.test(m), saw: m }; } } });
  throwsRow('a declared joiner that joins no name is refused by name', () => generateTmLanguage(joinerGrammar([{ text: '-', scope: 'x', prefix: 'y' }])), /declares `-`, which joins no tag or attribute name/);
  throwsRow('two declared prefix joiners are refused', () => generateTmLanguage(joinerGrammar([{ text: ':', scope: 'x', prefix: 'y' }, { text: '.', scope: 'x', prefix: 'y' }])), /at most one prefix joiner/);
}

// ── 3. the interpreter parses the dialect (its element region: code children, derived entry) ──
{
  section = 'parse';
  const p = createParser(dialect);
  const parses = (s: string) => { try { p.parse(s); return { ok: true, saw: 'parsed' }; } catch (e) { return { ok: false, saw: (e as Error).message.slice(0, 100) }; } };
  const rejects = (s: string) => { const r = parses(s); return { ok: !r.ok, saw: r.saw }; };
  const types = (s: string) => p.tokenize(s).map((t: { type: string; text: string }) => `${t.type || "'"}${t.text}`);
  const tokenRow = (id: string, s: string, want: string) => rows.push({ section, id, status: 'pass', check: () => { const ts = types(s); return { ok: ts.includes(want), saw: ts.join(' ') }; } });
  rows.push({ section, id: 'the whole dialect source parses', status: 'pass', check: () => parses(dialectSrc) });
  // a raw-text element (`rawText`): its body is ONE token up to `</style`, the close tag lexed after
  tokenRow('`<style>` body is one raw token', dialectSrc, 'StyleBody.a { color: red; }');
  tokenRow('the raw body keeps `<`, `{` and quotes verbatim', 'component C() { <style k="v">a <b> {c} "d</style> }', 'StyleBodya <b> {c} "d');
  tokenRow('the close tag after a raw body is the close-tag token', 'component C() { <style>x</style> }', 'CloseOpen</');
  tokenRow('an empty raw body is no token: the close tag follows the open tag', 'component C() { <style></style> }', 'CloseOpen</');
  tokenRow('the raw body ends only at `</style` (exact case: `</STYLE>` is body)', 'component C() { <style>a</STYLE>b</style> }', 'StyleBodya</STYLE>b');
  tokenRow('a self-closing `<style/>` has no raw body', 'component C() { <style/> "x" }', 'Str"x"');
  rows.push({ section, id: 'an element after a raw-text element parses', status: 'pass', check: () => parses('component C() { <a><style>.x{}</style><b/></a> }') });
  rows.push({ section, id: 'must reject: a raw-text element with no close tag (the body runs to the end)', status: 'pass', check: () => rejects('component C() { <style>abc }') });
  tokenRow('`</` in children is the close-tag token', 'component C() { <a>"x"</a> }', 'CloseOpen</');
  tokenRow('`/>` in a tag is the self-close token', 'component C() { <a/> }', 'SelfClose/>');
  tokenRow('children are code: a string child is the string token', 'component C() { <a>"x"</a> }', 'Str"x"');
  // `<` begins only element arms (grammar-analysis.ts tagOpenOnlyOpensTags), so a `<` right after
  // a value opens an element too (an operand-position entry would not enter here)
  tokenRow('a `<` right after a value in code opens an element', 'component C() { "z" <b/> }', 'SelfClose/>');
  rows.push({ section, id: 'a `<` right after a value in code opens an element (parses)', status: 'pass', check: () => parses('component C() { "z" <b/> }') });
  rows.push({ section, id: 'nested elements, directives and a dynamic tag in code children', status: 'pass', check: () => parses('component C() { <a k="v">@if (x) { <b>{n}</b> } @else { "e" } <{t} id="d">"s"</{t}></a> }') });
  rows.push({ section, id: 'must reject: `/>` outside an element', status: 'pass', check: () => rejects('component C() { "a" /> }') });
  rows.push({ section, id: 'must reject: `</a>` with no open element', status: 'pass', check: () => rejects('component C() { </a> }') });
  rows.push({ section, id: 'must reject: an element that is never closed', status: 'pass', check: () => rejects('component C() { <a>"x" }') });
  rows.push({ section, id: 'must reject: a code child the grammar does not have (an identifier)', status: 'pass', check: () => rejects('component C() { <a>x</a> }') });
}

const all = process.argv.includes('--all');
let pass = 0, xfail = 0, regress = 0, flipped = 0;
for (const r of rows) {
  let res: { ok: boolean; saw: string };
  try { res = r.check(); } catch (e) { res = { ok: false, saw: `threw: ${(e as Error).message}` }; }
  if (r.status === 'pass') { if (res.ok) pass++; else { regress++; console.log(`  ✗ REGRESSION ${r.id}\n      saw: ${res.saw}`); } }
  else if (res.ok) { flipped++; console.log(`  ✗ NOW PASSES (flip its mark to 'pass'): ${r.id}\n      saw: ${res.saw}`); }
  else xfail++;
  if (all) console.log(`  ${r.status === 'pass' ? (res.ok ? 'pass ' : 'FAIL ') : (res.ok ? 'XPASS' : 'xfail')} ${r.id}\n      saw: ${res.saw}${r.why && !res.ok ? `\n      why: ${r.why}` : ''}`);
}
for (const sec of ['dialect', 'textdialect', 'agnostic', 'parse']) {
  const rs = rows.filter(r => r.section === sec);
  console.log(`${sec}: ${rs.filter(r => r.status === 'pass').length} pass rows, ${rs.filter(r => r.status === 'xfail').length} expected-fail rows`);
}
console.log(`\n${pass} pass, ${xfail} expected-fail, ${regress} regressed, ${flipped} newly passing (of ${rows.length} rows)${regress + flipped ? '' : ' ✓'}`);
if (regress + flipped) process.exit(1);
