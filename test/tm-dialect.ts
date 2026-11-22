// tm-dialect.ts — what the TextMate generator does for an element dialect that is not React.
//
// Two parts, both measured on grammars defined in the repository (no committed artifact):
//   1. DIALECT rows: scope assertions on test/fixtures/elementdialect.ts (`@if` / `@each`
//      directive keywords next to an `@name` annotation token, directive regions, a dynamic
//      tag, shorthand attributes, a `<style>` raw-text body with a CSS embed).
//   2. AGNOSTIC rows: element syntax under rule names and conventions that are not JSX's
//      (no `JSX*` rules, a declared tag-name scope, no upper/lower-case convention, `"`-only
//      strings, no entities, no fragments; and a `[tag]…[/tag]` bracket syntax) must get its
//      vocabulary from the grammar, in the spirit of test/agnostic.ts.
//   3. PARSE rows: the interpreter (src/gen-parser.ts) parses the dialect source of part 1. The
//      fixture declares an element region with code children (docs/REGIONS.md), so these rows
//      gate the lexer's region frames on a grammar that is not JSX, beside the highlighter's.
//
// Every row states the behaviour WANTED. A row the generator does not meet yet is marked
// `xfail` with its reason and the editor-queue item expected to flip it. The gate fails when a
// `pass` row fails (a regression) AND when an `xfail` row passes (flip its mark in the same
// commit, so the record says what changed).
//   node test/tm-dialect.ts           run, print failures and the counts
//   node test/tm-dialect.ts --all     print every row with the scopes it saw
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { token, rule, defineGrammar, seq, oneOf, range, star, sep, opt, many, alt, noneOf } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import dialect from './fixtures/elementdialect.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

// An embedded grammar the dialect's `<style>` body should delegate to. A stub is enough: a
// row asks only whether the body lands under `source.css`.
const cssStub = { scopeName: 'source.css', patterns: [{ match: '[a-z-]+(?=\\s*:)', name: 'support.type.property-name.css' }] };

async function load(g: CstGrammar) {
  const tm = generateTmLanguage(g);
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
    loadGrammar: async (sc: string) => sc === tm.scopeName ? parseRawGrammar(JSON.stringify(tm), 'g.json')
      : sc === 'source.css' ? parseRawGrammar(JSON.stringify(cssStub), 'css.json') : null,
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
  const children = 'element children are a fixed JSX-children repository (`generateJsxPatterns`) that reads no grammar rule, so a directive inside an element is plain child text (items 2 and 6)';
  scopeRow('`@if` inside element children is a keyword', 'xfail', children, g, src, '@if', 2, s => inner(s).startsWith('keyword.control.conditional'));
  scopeRow('`@empty` inside element children is a keyword', 'xfail', children, g, src, '@empty', 0, s => inner(s).startsWith('keyword.control.loop'));
  scopeRow('`of` inside element children is a keyword', 'xfail', children, g, src, 'of item', 1, s => inner(s).startsWith('keyword.control.loop'));
  scopeRow('a directive region `{` in children is not an expression container', 'xfail', children, g, src, '{', 4, s => !has('meta.embedded.expression')(s));
  scopeRow('an element inside a directive region keeps tag scopes', 'pass', undefined, g, src, 'span', 0, s => inner(s).startsWith('entity.name.tag'));
  const dyn = 'the tag-open pattern requires a name after `<`; the grammar\'s `TagName` arm `{ Expr }` is not read (item 6: rule-driven element patterns)';
  scopeRow('dynamic tag `<{…}` opens a tag', 'xfail', dyn, g, src, '<{item.tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('attribute of a dynamic tag is an attribute name', 'xfail', dyn, g, src, 'id=', 0, s => inner(s).startsWith('entity.other.attribute-name'));
  scopeRow('dynamic close tag `</{…}>` closes a tag', 'xfail', dyn, g, src, '</{item.tag}', 0, s => inner(s).startsWith('punctuation.definition.tag.begin'));
  scopeRow('`<style>` body is embedded CSS', 'xfail',
    'a token-stream grammar has no lexer region with an embed: the body is one token, and the JSX children patterns reach `<style>` first (item 6)',
    g, src, 'color', 0, has('source.css'));
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
    rules: { Label, Prop, Widget, Markup },
  });
  const { tm, grammar: g } = await load(angle);
  const src = '<Panel/>\n<row data.key="k">"text"</row>';
  const vocab = '`generateJsxPatterns` emits a fixed repository with React\'s vocabulary whatever the grammar declares (item 6: rule-driven element patterns)';
  scopeRow('capitalised tag `Panel` takes the declared `entity.name.tag`, not React\'s component scope', 'xfail', vocab, g, src, 'Panel', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('lowercase tag `row` is `entity.name.tag` (by React\'s lowercase convention today, not from the declaration)', 'pass', undefined, g, src, 'row', 0, s => inner(s).startsWith('entity.name.tag'));
  for (const part of ['data', '.', 'key'])
    scopeRow(`dotted attribute name \`data.key\`: \`${part}\` is part of the attribute name`, 'pass', undefined, g, src, part === '.' ? '.key' : part, 0, s => has('entity.other.attribute-name')(s));
  scopeRow('element children are not scoped `meta.jsx.*` in a grammar with no JSX rule', 'xfail', vocab, g, src, '"text"', 0, s => !s.some(x => x.includes('.jsx.')));
  const repoRow = (id: string, test: (keys: string[], json: string) => boolean) =>
    rows.push({ section, id, status: 'xfail', why: vocab, check: () => { const keys = Object.keys(tm.repository); const json = JSON.stringify(tm); return { ok: test(keys, json), saw: keys.filter(k => k.includes('jsx')).join(' ') || '(none)' }; } });
  repoRow('repository keys come from the grammar\'s rule names (no `jsx-*` keys)', keys => !keys.some(k => k.startsWith('jsx')));
  repoRow('no single-quoted attribute string: the grammar\'s only string token is `"…"`', keys => !keys.some(k => /single-quoted/.test(k)));
  repoRow('no character-entity pattern: the grammar declares no entities', keys => !keys.some(k => /entity/.test(k)));
  repoRow('no fragment `<>` pattern: no rule has `<` directly followed by `>`', keys => !keys.some(k => /fragment/.test(k)));

  // The same element structure with `[tag …]…[/tag]` brackets: the tag-name scope is declared,
  // so it must reach the tag name whatever the delimiters.
  const BName = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });
  const BQuoted = token(seq('"', star(noneOf('"')), '"'), { string: true, scope: 'string.quoted.double' });
  const BClose = token(seq('[', '/'));
  const BTag = rule(() => [[BName]]);
  const BElem = rule(($) => [['[', BTag, ']', many(alt($, BQuoted)), BClose, BTag, ']']]);
  const BDoc = rule(() => [many(BElem)]);
  const bracket = defineGrammar({
    name: 'bracketmarkup', scopeName: 'source.bracketmarkup',
    tokens: { BName, BQuoted, BClose },
    contextualScopes: [{ token: BName, within: BTag, scope: 'entity.name.tag' }],
    rules: { BTag, BElem, BDoc },
  });
  const { grammar: bg } = await load(bracket);
  const bsrc = '[note]"hi"[/note]';
  const ctx = '`contextualScopes` reach the TextMate output only inside the derived call-argument and comment-continuation regions; an element rule is no such region (item 6)';
  scopeRow('`[note]`: the declared tag-name scope reaches a bracket-delimited tag', 'xfail', ctx, bg, bsrc, 'note', 0, s => inner(s).startsWith('entity.name.tag'));
  scopeRow('`[/note]`: the declared tag-name scope reaches the close tag', 'xfail', ctx, bg, bsrc, 'note', 1, s => inner(s).startsWith('entity.name.tag'));
}

// ── 3. the interpreter parses the dialect (its element region: code children, derived entry) ──
{
  section = 'parse';
  const p = createParser(dialect);
  const parses = (s: string) => { try { p.parse(s); return { ok: true, saw: 'parsed' }; } catch (e) { return { ok: false, saw: (e as Error).message.slice(0, 100) }; } };
  const rejects = (s: string) => { const r = parses(s); return { ok: !r.ok, saw: r.saw }; };
  const types = (s: string) => p.tokenize(s).map((t: { type: string; text: string }) => `${t.type || "'"}${t.text}`);
  const tokenRow = (id: string, s: string, want: string) => rows.push({ section, id, status: 'pass', check: () => { const ts = types(s); return { ok: ts.includes(want), saw: ts.join(' ') }; } });
  const styleLine = dialectSrc.split('\n').findIndex(l => l.includes('<style>'));
  const withoutStyle = dialectSrc.split('\n').filter((_, i) => i !== styleLine).join('\n');
  rows.push({ section, id: 'the dialect source without its `<style>` line parses', status: 'pass', check: () => parses(withoutStyle) });
  rows.push({ section, id: 'the whole dialect source parses', status: 'xfail', why: 'the `<style>` body is CSS, which code children cannot lex; it needs the region\'s raw-text frame (docs/REGIONS.md, build step 3)', check: () => parses(dialectSrc) });
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
for (const sec of ['dialect', 'agnostic', 'parse']) {
  const rs = rows.filter(r => r.section === sec);
  console.log(`${sec}: ${rs.filter(r => r.status === 'pass').length} pass rows, ${rs.filter(r => r.status === 'xfail').length} expected-fail rows`);
}
console.log(`\n${pass} pass, ${xfail} expected-fail, ${regress} regressed, ${flipped} newly passing (of ${rows.length} rows)${regress + flipped ? '' : ' ✓'}`);
if (regress + flipped) process.exit(1);
