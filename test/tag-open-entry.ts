// tag-open-entry.ts — `tagOpenOnlyOpensTags` (src/grammar-analysis.ts): whether a grammar uses its
// element region's `tagOpen` only to open tags, the derived fact that decides how the lexer
// enters an element region from code (docs/REGIONS.md, "Entry from code").
//   true  → every `tagOpen` in code opens an element;
//   false → only a `tagOpen` where an operand may start (`!prevIsValue()` + `typeParameters`).
// Rows: the repository's grammars and fixtures (each with the answer its own rules imply), then
// toy near-misses, one per clause of the definition, each flipping the answer to false; then
// what the lexer does with the answer, on a toy where it is observable (a regex token makes
// `prevIsValue` say "value" after an identifier).
import { token, rule, defineGrammar, seq, oneOf, range, star, plus, many, opt, sep, left, op, not, noneOf } from '../src/api.ts';
import { tagOpenOnlyOpensTags } from '../src/grammar-analysis.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import type { CstGrammar, ElementRegion } from '../src/types.ts';
import javascript from '../javascript.ts';
import typescript from '../typescript.ts';
import javascriptreact from '../javascriptreact.ts';
import typescriptreact from '../typescriptreact.ts';
import dialect from './fixtures/elementdialect.ts';
import textDialect from './fixtures/textdialect.ts';

let ok = 0, fail = 0;
const row = (id: string, got: boolean, want: boolean) => {
  if (got === want) ok++; else { fail++; console.log(`  ✗ ${id}: got ${got}, want ${want}`); }
};

// JSX's region shape, for the base grammars that declare none (the question is what their rules imply).
const jsxShape: ElementRegion = { tagOpen: '<', tagClose: '>', closeMarker: '/', text: 'JSXText', closeTag: 'JSXClose', selfClose: 'JSXSelfClose', hole: { open: '{', close: '}' } };
row('javascript: `<` is a relational operator', tagOpenOnlyOpensTags(javascript, jsxShape), false);
row('typescript: `<` is a relational operator and opens type arguments', tagOpenOnlyOpensTags(typescript, jsxShape), false);
row('javascriptreact: `<` is a relational operator', tagOpenOnlyOpensTags(javascriptreact, javascriptreact.elements!), false);
row('typescriptreact: `<` is a relational operator and opens type arguments', tagOpenOnlyOpensTags(typescriptreact, typescriptreact.elements!), false);
row('elementdialect: `<` begins only element arms', tagOpenOnlyOpensTags(dialect, dialect.elements!), true);
row('textdialect: `<` is also a relational operator', tagOpenOnlyOpensTags(textDialect, textDialect.elements!), false);

// Toys: a minimal element grammar, then one change per clause.
const Ident = token(seq(oneOf(range('a', 'z')), star(oneOf(range('a', 'z')))), { identifier: true });
const Shut = token(seq('<', '/'));
const Solo = token(seq('/', '>'));
const region: ElementRegion = { tagOpen: '<', tagClose: '>', closeMarker: '/', closeTag: 'Shut', selfClose: 'Solo', hole: { open: '{', close: '}' } };
function toy(extra: { expr?: (E: unknown) => unknown[]; tokens?: Record<string, ReturnType<typeof token>>; prec?: unknown[] } = {}): CstGrammar {
  const Expr = rule(($) => [Ident, ...(extra.expr?.($) ?? [])] as never);
  const Elem = rule(($) => [['<', Ident, Solo], ['<', Ident, '>', many($), Shut, Ident, '>']]);
  const Prog = rule(() => [[many(Elem), opt(Expr)]]);
  return defineGrammar({ name: 'toy', tokens: { Ident, Shut, Solo, ...extra.tokens }, rules: { Expr, Elem, Prog }, entry: Prog, elements: region, ...(extra.prec ? { prec: extra.prec as never } : {}) });
}
row('toy: `<` only at the head of element arms', tagOpenOnlyOpensTags(toy(), region), true);
row('toy: `<` in an operator table', tagOpenOnlyOpensTags(toy({ expr: ($) => [[$, op, $]], prec: [left('<')] }), region), false);
row('toy: `<` inside an arm, not at its head (type arguments)', tagOpenOnlyOpensTags(toy({ expr: () => [[Ident, '<', Ident, '>']] }), region), false);
row('toy: `<` at the head of an arm with no close-tag / self-close (a bracket pair)', tagOpenOnlyOpensTags(toy({ expr: () => [['<', Ident, '>']] }), region), false);
row('toy: another literal begins with `<` (`<=`)', tagOpenOnlyOpensTags(toy({ expr: () => [[Ident, '<=', Ident]] }), region), false);
row('toy: `<` as a separator', tagOpenOnlyOpensTags(toy({ expr: () => [['(', sep(Ident, '<'), ')']] }), region), false);
row('toy: `<` inside a lookahead', tagOpenOnlyOpensTags(toy({ expr: () => [[Ident, not('<')]] }), region), false);
row('toy: a scanned token begins with `<`', tagOpenOnlyOpensTags(toy({ tokens: { Raw: token(seq('<raw>', star(oneOf(range('a', 'z'))), '</raw>')) } }), region), false);

// The lexer reads the fact once (lexSpecOf → `elementEntry`). A toy with a regex token, whose
// `<` begins only element arms: after the value `x`, the derived entry opens an element; the
// operand-position entry (what a grammar whose `<` is also an operator gets) does not, and the
// `/` after `b` is then a regex attempt.
{
  const Rx = token(seq('/', plus(noneOf('/', '\n')), '/'), { regex: true, regexContext: { divisionAfterTypes: ['Ident'], divisionAfterTexts: [], regexAfterTexts: [], regexAfterParenKeywords: [], memberAccessTexts: [], postfixAfterValueTexts: [] } });
  const Item = rule(($) => [Ident, Rx, ['<', Ident, Solo], ['<', Ident, '>', many($), Shut, Ident, '>']]);
  const Prog = rule(() => [[many(Item)]]);
  const g = defineGrammar({ name: 'toyrx', tokens: { Ident, Rx, Shut, Solo }, rules: { Item, Prog }, entry: Prog, elements: region });
  const spec = lexSpecOf(g);
  row('toyrx: lexSpecOf records the derived entry', spec.elementEntry === 'always', true);
  const kinds = (sp: typeof spec) => { try { return compileTokenizer(sp)('x <b/>').map((t) => t.type || t.text).join(' '); } catch (e) { return 'threw: ' + (e as Error).message; } };
  row('toyrx: derived entry: `x <b/>` lexes an element after a value', kinds(spec) === 'Ident < Ident Solo', true);
  const { elementEntry: _, ...operand } = spec;
  row('toyrx: operand entry: `x <b/>` does not', kinds(operand) === 'Ident < Ident Solo', false);
}

console.log(fail === 0 ? `\n${ok}/${ok} tag-open entry rows ✓` : `\n${fail} of ${ok + fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
