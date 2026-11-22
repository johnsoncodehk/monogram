// Gate: the TEXT DIALECT fixture (test/fixtures/textdialect.ts), a template language of the
// shape of a TSX template dialect, lexed and parsed by the interpreter from its grammar file
// alone (docs/REGIONS.md). Each row is a token or parse fact of the region's declared data:
// `tagStart`, a raw-text body condition (`unlessBodyStarts`). A row is `pass` or `xfail` (an
// expected failure, with its cause); an xfail that passes fails the gate until its mark flips.
//   node test/text-dialect.ts [--all]
import { createParser } from '../src/gen-parser.ts';
import { directivesOf } from '../src/grammar-analysis.ts';
import { lexSpecOf } from '../src/emit-lexer.ts';
import { token, rule, defineGrammar, seq, oneOf, range, star, plus, noneOf, many, alt } from '../src/api.ts';
import type { CstGrammar } from '../src/types.ts';
import dialect from './fixtures/textdialect.ts';

type Row = { section: string; id: string; status: 'pass' | 'xfail'; why?: string; check: () => { ok: boolean; saw: string } };
const rows: Row[] = [];
let section = '';
const p = createParser(dialect);
const parses = (s: string) => { try { p.parse(s); return { ok: true, saw: 'parsed' }; } catch (e) { return { ok: false, saw: (e as Error).message.slice(0, 100) }; } };
const rejects = (s: string) => { const r = parses(s); return { ok: !r.ok, saw: r.saw }; };
const lexes = (s: string) => { try { return p.tokenize(s).map((t: { type: string; text: string }) => `${t.type || "'"}${JSON.stringify(t.text)}`); } catch (e) { return [`threw: ${(e as Error).message.slice(0, 80)}`]; } };
const C = (body: string) => `component C(a) { ${body} }`;
// `want` is a run of consecutive tokens, each written `Type"text"` (`'"text"` for a literal)
const tokens = (id: string, s: string, want: string[], status: Row['status'] = 'pass', why?: string) => rows.push({
  section, id, status, why, check: () => { const ts = lexes(s); const at = ts.findIndex((_, i) => want.every((w, j) => ts[i + j] === w)); return { ok: at >= 0, saw: ts.join(' ') }; },
});
const parse = (id: string, s: string, status: Row['status'] = 'pass', why?: string) => rows.push({ section, id, status, why, check: () => parses(s) });
const reject = (id: string, s: string) => rows.push({ section, id: `must reject: ${id}`, status: 'pass', check: () => rejects(s) });

// ── tag start: `<` opens a tag only before a `tagStart` character ──
section = 'tag start';
tokens('in text, `<` before a blank is text', C('<p>1 < 2 > 0</p>'), ['Text"1 < 2 > 0"', 'CloseTag"</"']);
tokens('in text, `<` before a digit is text', C('<p>a<9</p>'), ['Text"a<9"']);
tokens('in text, `<` before another `<` is text, and that one opens the close tag', C('<p>a <</p>'), ['Text"a <"', 'CloseTag"</"']);
tokens('in text, `<` at the start of the children is text', C('<p>< b</p>'), ['\'">"', 'Text"< b"']);
tokens('in text, `<` before a letter opens a tag', C('<p>1<b/>2</p>'), ['Text"1"', '\'"<"', 'Ident"b"', 'SelfClose"/>"', 'Text"2"']);
tokens('in text, `<` before `>` opens a fragment', C('<p>1<>2</></p>'), ['Text"1"', '\'"<"', '\'">"', 'Text"2"', 'CloseTag"</"', '\'">"']);
tokens('in text, `<` before `{` opens a dynamic tag', C('<p><{a}>x</{a}></p>'), ['\'">"', '\'"<"', '\'"{"', 'Ident"a"']);
tokens('in text, `<` before `_` and `$` opens a tag', C('<p><_a/><$b/></p>'), ['\'"<"', 'Ident"_a"', 'SelfClose"/>"', '\'"<"', 'Ident"$b"']);
tokens('in code, `<` before a blank is the operator at an operand position', C('const b = < 1;'), ['\'"="', '\'"<"', 'Number"1"']);
tokens('in code, `<` after a value is the operator', C('const b = a <c;'), ['Ident"a"', '\'"<"', 'Ident"c"', '\'";"']);
parse('text with non-tag `<` and nested elements parses', C('<p>1 < 2 <b>x</b> a<9 <></> <{a}>y</{a}></p>;'));
parse('a comparison and an element in one statement', C('const b = a < 1; return <p>x</p>;'));
reject('`<` before a blank where an operand may start is no element', C('const b = < p/>;'));
reject('an element after a value on the same line is a comparison', C('<a/> <b/>'));

// ── raw text: `<script>` always, `<style>` unless its body starts with the hole opener ──
section = 'raw text';
tokens('`<style>` with CSS is one raw body', C('<style>.a { b: c } <i></style>'), ['StyleBody".a { b: c } <i>"', 'CloseTag"</"', 'Ident"style"']);
tokens('`<style>{css}</style>` is an element with a hole', C('<style>{a}</style>'), ['\'">"', '\'"{"', 'Ident"a"', '\'"}"', 'CloseTag"</"']);
tokens('`<style>` with blanks then `{` is an element with a hole', C('<style> \n\t{a}</style>'), ['Text" \\n\\t"', '\'"{"', 'Ident"a"']);
tokens('`<style>` with text before a `{` is raw', C('<style>x{a}</style>'), ['StyleBody"x{a}"']);
tokens('`<style>` whose body starts with a comment then `{` is raw (comments are not skipped)', C('<style>/* c */{a}</style>'), ['StyleBody"/* c */{a}"']);
tokens('`<style> ` with blanks only is raw', C('<style>  </style>'), ['StyleBody"  "', 'CloseTag"</"']);
tokens('`<script>{a}</script>` is raw: the condition is per declaration', C('<script>{a}</script>'), ['ScriptBody"{a}"']);
tokens('`<SCRIPT>` is raw in any case, closed in any case', C('<SCRIPT>if (a<b) x</Script>'), ['ScriptBody"if (a<b) x"', 'CloseTag"</"', 'Ident"Script"']);
tokens('`<style>` is exact case: `<STYLE>{a}` is an element with a hole either way', C('<STYLE>{a}</STYLE>'), ['\'"{"', 'Ident"a"']);
tokens('`<STYLE>` is no raw-text name: its text is text', C('<STYLE>.a</STYLE>'), ['Text".a"']);
tokens('an empty `<style></style>` has no body token', C('<style></style>'), ['\'">"', 'CloseTag"</"']);
parse('raw and hole `<style>`, `<script>`, `<style/>`', C('<style>.a{}</style>; <style> {a}</style>; <script>x < y</script>; <style/>;'));
reject('a hole `<style>` whose hole is not an expression', C('<style>{.a}</style>'));
reject('a raw `<style>` with no close tag', C('<style>.a{}'));

// ── comments in text (`textTokens`): `/*` anywhere, `//` at a run's start or after a blank ──
section = 'comments';
tokens('`/* */` inside a word ends the run: text, comment, text', C('<p>a/* c */b</p>'), ['Text"a"', 'Text"b"']);
tokens('`//` after a blank is a comment to the end of the line', C('<p>hi // note\n x</p>'), ['Text"hi "', 'Text"\\n x"', 'CloseTag"</"']);
tokens('`//` touching text is text (`a//b`, a URL)', C('<p>a//b https://x.dev</p>'), ['Text"a//b https://x.dev"']);
tokens('`//` at the run\'s start, right after a tag, is a comment', C('<p><b>z</b>// n\n</p>'), ['\'">"', 'Text"\\n"', 'CloseTag"</"', 'Ident"p"']);
tokens('`//` at the run\'s start, right after a hole, is a comment', C('<p>{a}// n\n</p>'), ['\'"}"', 'Text"\\n"']);
tokens('a line comment swallows a close tag on its line', C('<p>a // </p>\n</p>'), ['Text"a "', 'Text"\\n"', 'CloseTag"</"']);
tokens('an unterminated `/*` is text', C('<p>q /*</p>'), ['Text"q /*"', 'CloseTag"</"']);
tokens('a comment that is the whole children leaves no text', C('<p>/* only */</p>'), ['\'">"', 'CloseTag"</"']);
// after a text token a new run starts, so a `//` right after `*/` is at a run's start (the
// evaluated dialect keeps `/* a */// b` as text: its block comment does not end the run)
tokens('`//` right after a block comment starts a new run: a comment', C('<p>/* a */// b\n</p>'), ['\'">"', 'Text"\\n"']);
tokens('code comments are unchanged', C('const b = 1; // c\n/* d */ return b;'), ['\'";"', 'Ident"return"']);
parse('text with comments parses', C('<p>hi // note\n a/* c */b <b>z</b>// n\n a//b</p>;'));
reject('a comment does not end an element: its close tag is commented out', C('<p>a // </p>'));

// ── directives: openers, heads, bodies, continuations, all derived from the rules ──
section = 'directives';
const derived = directivesOf(dialect, dialect.elements!)!;
const table = (es: { lit: string; nexts: string[][] }[]) => es.map((e) => `${e.lit} ${e.nexts.map((n) => n.join(' ')).join(' | ')}`).join('; ');
console.log(`derived openers: ${table(derived.openers)}\nderived continuations: ${table(derived.continuations)}\nderived code blocks: ${derived.blocks.join(' ')}\nrefused arms: ${derived.refused.length}`);
rows.push({ section, id: 'the derived openers', status: 'pass', check: () => { const s = table(derived.openers); return { ok: s === '@if (; @for await ( | (; @try {', saw: s }; } });
rows.push({ section, id: 'the derived continuations', status: 'pass', check: () => { const s = table(derived.continuations); return { ok: s === '@else if ( | {; @empty {; @pending {; @catch (', saw: s }; } });
rows.push({ section, id: 'the derived code block opener, and no refused arm', status: 'pass', check: () => ({ ok: derived.blocks.join() === '@{' && derived.refused.length === 0, saw: `${derived.blocks} / ${derived.refused.length}` }) });
// the opener test: the literal, not running on into a word, then its required next literal
tokens('`@if (` opens a directive', C('<p>@if (a) {y}</p>'), ['\'">"', 'AtWord"@if"', '\'"("']);
tokens('`@if x` is text: its required next is `(`', C('<p>@if x</p>'), ['Text"@if x"']);
tokens('`@iffy (` is text: the literal runs on into a word', C('<p>@iffy (a)</p>'), ['Text"@iffy (a)"']);
tokens('`a@if (` ends the text before the `@`', C('<p>a@if (a) {y}</p>'), ['Text"a"', 'AtWord"@if"']);
tokens('`x@if (y)` likewise, inside a run', C('<p>x y@if (a) {z}</p>'), ['Text"x y"', 'AtWord"@if"']);
tokens('`@for await (` opens a directive', C('<p>@for await (i of a) {y}</p>'), ['AtWord"@for"', 'Ident"await"', '\'"("']);
tokens('`@for awaits (` is text', C('<p>@for awaits (i)</p>'), ['Text"@for awaits (i)"']);
tokens('`@{` opens a code block', C('<p>@{ const q = 1; <b/> }</p>'), ['\'"@{"', 'Ident"const"']);
tokens('a comment between the literal and its `(` is code trivia', C('<p>@if /* c */ (a) {y}</p>'), ['AtWord"@if"', '\'"("']);
tokens('a line comment too', C('<p>@if // c\n (a) {y}</p>'), ['AtWord"@if"', '\'"("']);
tokens('`@else` in text is text: it is no opener', C('<p>a @else {b}</p>'), ['Text"a @else "']);
// heads: a `{` opens the body only at the head’s own paren depth
parse('braces inside the head’s parens open no body', C('<p>@if ({a}.a) { y }</p>;'));
parse('brackets and braces inside the head’s parens open no body', C('<p>@if ([{a}][0]) { y }</p>;'));
tokens('the body after a braced head is text', C('<p>@if ({a}.a) { y }</p>'), ['\'")"', '\'"{"', 'Text" y "', '\'"}"']);
// bodies and continuations
tokens('a continuation right after a body', C('<p>@if (a) {y} @else {n}</p>'), ['\'"}"', 'AtWord"@else"', '\'"{"', 'Text"n"']);
tokens('`@else if (` continues', C('<p>@if (a) {y} @else if (a) {m} @else {n}</p>'), ['AtWord"@else"', 'Ident"if"', '\'"("']);
tokens('`@else x` is no continuation: the directive ends, the rest is text', C('<p>@if (a) {y} @else x</p>'), ['\'"}"', 'Text" @else x"']);
tokens('`@elsewhere {` is no continuation', C('<p>@if (a) {y} @elsewhere {n}</p>'), ['\'"}"', 'Text" @elsewhere "']);
tokens('text between a body and `@else` ends the directive', C('<p>@if (a) {y} t @else {n}</p>'), ['Text" t @else "']);
parse('`@for … @empty`, `@try … @pending … @catch`, `@try … @catch`', C('<p>@for (i of a) {<i>{i}</i>} @empty {none} @try {t} @pending {p} @catch (e) {c} @try {t} @catch (e) {c}</p>;'));
parse('directives nest, with elements, holes and comments in bodies', C('<p>@if (a) { <b>@for (i of a) { {i} // n\n }</b> } @else { /* c */ x }</p>;'));
parse('a code block with statements and an element', C('<p>@{ const q = 1; <b/> } x</p>;'));
parse('the whole chain', C('<p>x @if (a) { yes <b/> } @else if (a) {m} @else { no } z</p>;'));
reject('a body never closed', C('<p>@if (a) {y</p>;'));
// a close tag in a body closes no element of the body: it is lexed in a frame of its own (popped
// at its `>`), so the parser sees a close tag where the body admits only children, and rejects
tokens('a stray close tag in a body: lexed as a close tag, the body goes on', C('<p>@if (a) { </q> y }</p>'), ['CloseTag"</"', 'Ident"q"', '\'">"', 'Text" y "', '\'"}"']);
reject('a stray close tag in a body', C('<p>@if (a) { </q> y }</p>;'));
reject('a body closer outside a body (`}` in an element’s children)', C('<p>a } b</p>;'));
tokens('with no directive before it, `@else {n}` is text and a hole', C('<p>@else {n}</p>'), ['Text"@else "', '\'"{"']);
// what the derivation refuses, by name: arms whose head or body the lexer could not delimit
{
  const Ident = token(seq(oneOf(range('a', 'z')), star(oneOf(range('a', 'z')))), { identifier: true });
  const AtW = token(seq('@', oneOf(range('a', 'z')), star(oneOf(range('a', 'z')))));
  const Txt = token(plus(noneOf('<', '{', '}')));
  const Shut = token(seq('<', '/'));
  const Solo = token(seq('/', '>'));
  const toy = (arms: (B: unknown) => unknown[]): CstGrammar => {
    const Body = rule(() => [['{', many(Txt), '}']]);
    const Dir = rule(() => arms(Body) as never);
    const El = rule(() => [['<', Ident, '>', many(alt(Txt, Dir)), Shut, Ident, '>']]);
    const Prog = rule(() => [[many(El)]]);
    return defineGrammar({ name: 'dirtoy', tokens: { Ident, AtW, Txt, Shut, Solo }, rules: { Body, Dir, El, Prog }, entry: Prog,
      elements: { tagOpen: '<', tagClose: '>', closeMarker: '/', text: 'Txt', closeTag: 'Shut', selfClose: 'Solo', hole: { open: '{', close: '}' } } });
  };
  const refusal = (id: string, g: () => CstGrammar, want: RegExp) => rows.push({ section, id: `refused by name: ${id}`, status: 'pass', check: () => {
    const gr = g(); const d = directivesOf(gr, gr.elements!)!;
    let threw = ''; try { lexSpecOf(gr); } catch (e) { threw = (e as Error).message; }
    const r = d.refused.map((x) => `${x.arm}: ${x.reason}`).join(' / ');
    console.log(`  refused (${id}): ${r}`);
    return { ok: want.test(r) && threw.includes(d.refused[0]?.arm ?? '\0'), saw: `${r} | lexSpecOf: ${threw.split('\n')[0]}` };
  } });
  refusal('a bare expression head (`@if x {`: the head could hold the body opener)', () => toy((B) => [['@if', Ident, B]]), /@if.*Ident.*stands between it and its body/);
  refusal('an opener followed by an expression (`@case x:`)', () => toy(() => [['@case', Ident, ':']]), /@case.*Ident.*stands between/);
  refusal('an opener with nothing after it', () => toy(() => [['@here']]), /@here.*nothing follows it/);
  refusal('a head not followed by a body', () => toy(() => [['@if', '(', Ident, ')', Txt]]), /@if.*head `\( … \)` is not followed by a body/);
  rows.push({ section, id: 'a derivable toy has no refusal and loads', status: 'pass', check: () => { const gr = toy((B) => [['@if', '(', Ident, ')', B]]); const d = directivesOf(gr, gr.elements!)!; let ok = true; try { lexSpecOf(gr); } catch { ok = false; } return { ok: ok && d.refused.length === 0 && d.openers.length === 1, saw: JSON.stringify(d) }; } });
}

// ── entry: where code enters an element (derived: `operand`, `<` is also relational) ──
section = 'entry';
parse('an element after `return`, `=`, `;` and `{`', C('<a/>; const b = <i/>; return <p/>;'));
// The evaluated dialect renders an element that starts a line, after a value on the line
// before; a lexer-local region reads the `<` after a value as the operator (docs/REGIONS.md,
// "What a lexer-local region cannot decide").
parse('an element on the line after a value', C('const b = 1\n<i/>'), 'xfail', 'needs parser context: after the value `1` the lexer reads `<` as the operator (the line-start rule of the evaluated dialect is a statement-level fact)');

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
