// Throwaway PoC: verify the indentation lexer emits correct INDENT/DEDENT/NEWLINE and that the
// first-cut yaml.ts grammar parses common documents. Run: node test/yaml-poc.ts
import { createLexer } from '../src/gen-lexer.ts';
import { createParser } from '../src/gen-parser.ts';
import grammar from '../yaml.ts';

const { tokenize } = createLexer(grammar);
const { parse } = createParser(grammar);

const samples = [
  'a: 1\nb: 2',
  'a:\n  b: 1\n  c: 2\nd: 3',
  '- one\n- two\n- three',
  'key:\n  - a\n  - b',
  'nested:\n  list:\n    - x\n    - y\n  val: z',
  '{a: 1, b: 2}',
  '[1, 2, 3]',
  'name: "John"\nage: 30',
  'list: [a, b, c]',
  '# comment\nkey: value  # trailing',
];

const show = (t: any) =>
  t.type === 'Indent' ? '»IND' : t.type === 'Dedent' ? '«DED' : t.type === 'Newline' ? '⏎NL'
  : t.type === '' ? JSON.stringify(t.text) : `${t.type}(${JSON.stringify(t.text)})`;

for (const s of samples) {
  console.log('\n=== ' + JSON.stringify(s) + ' ===');
  let toks: any[];
  try { toks = tokenize(s); } catch (e) { console.log('  LEX THREW:', (e as Error).message); continue; }
  console.log('  toks:', toks.map(show).join(' '));
  try { parse(s); console.log('  PARSE: ok'); } catch (e) { console.log('  PARSE FAIL:', (e as Error).message.split('\n')[0]); }
}
