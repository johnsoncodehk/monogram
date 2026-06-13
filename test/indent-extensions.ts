// Indent-mode extensions for non-YAML indentation languages, specified as
// engine behavior over TOY grammars (token names and introducer characters
// deliberately unlike any real language — the behaviors are grammar DATA).
//
// Three opt-in IndentConfig fields, each motivated by a Pug-like indentation
// language (one that nests HTML-ish tag lines rather than key/value scalars):
//
//   1. `commentExcept`   — two-tier comments: `--` lines vanish (invisible to
//                          the indent stack, like YAML `#`), but `--!` lines
//                          are REAL tokens (doc comments that ship to output).
//   2. `rawBlock`        — verbatim capture introduced from the END of a line
//                          (`tag:mode` filters/content modes, Pug-style); the
//                          mirror image of YAML's leading `|`/`>` blockScalar.
//   3. `flowColonSeparator: false` — languages with `:name`-shaped tokens
//                          (bound-attribute shorthand) need a `:` after a
//                          quoted value / flow-close to stay a token start,
//                          not YAML's forced `key: value` separator punct.
//
// All three default OFF — a grammar declaring none (YAML) tokenizes
// byte-identically, which the yaml gates already enforce.
import { token, rule, defineGrammar, alt, many, many1, opt, seq, oneOf, noneOf, range, star, plus, never } from '../src/api.ts';
import type { IndentConfig } from '../src/types.ts';
import { createLexer } from '../src/gen-lexer.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { cond ? ok++ : (fail++, console.log('  ✗', label)); };

type Tok = { type: string; text: string };
const types = (toks: Tok[]) => toks.map(t => `${t.type || 'punct'}:${t.text}`);
const lexed = (g: ReturnType<typeof defineGrammar>, src: string): Tok[] => createLexer(g as any).tokenize(src) as any;

// Shared toy tokens
const lower = range('a', 'z');
const Word = token(plus(lower), { identifier: true });
const Str = token(seq('"', star(noneOf('"')), '"'), { string: true });

// ─────────────────────────────────────────────────────────────────────────────
// 1. commentExcept — exception string after the comment introducer
// ─────────────────────────────────────────────────────────────────────────────
{
  const Indent = token(never(), {});
  const Dedent = token(never(), {});
  const Newline = token(never(), {});
  // `--! …` doc comment: a REAL token. Declared before the skip token (`--` is its prefix).
  const DocNote = token(seq('--!', star(noneOf('\n'))), {});
  const Strip = token(seq('--', star(noneOf('\n'))), { skip: true });
  const Line = rule(() => [[alt(Word, DocNote)], [Word]]);
  const Lines = rule(() => [[Line, many(Newline, Line)]]);
  const Doc = rule(() => [[opt(Lines), opt(Indent), opt(Lines), opt(Dedent)]]);

  const mk = (indent: IndentConfig) => defineGrammar({
    name: 'tiny', tokens: { Indent, Dedent, Newline, DocNote, Strip, Word }, rules: { Line, Lines, Doc }, entry: Doc, indent,
  });
  const base: IndentConfig = { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', comment: '--' };
  const gDefault = mk(base);
  const gExcept = mk({ ...base, commentExcept: '!' });

  // Comment-only lines stay invisible to the indent stack — with or without the option.
  check('commentExcept: plain comment lines remain invisible',
    types(lexed(gExcept, 'aaa\n-- note\nbbb')).join(' ') === types(lexed(gExcept, 'aaa\nbbb')).join(' '));
  check('commentExcept: a DEEPER comment-only line emits no Indent',
    !types(lexed(gExcept, 'aaa\n    -- deep note\nbbb')).some(t => t.startsWith('Indent')));

  // The exception: `--!` lines fall through to tokenization and are REAL tokens.
  check('commentExcept: introducer+exception lines tokenize (DocNote token present)',
    lexed(gExcept, 'aaa\n--! ship me\nbbb').some(t => t.type === 'DocNote' && t.text === '--! ship me'));
  check('commentExcept: doc-comment lines are STRUCTURAL (sibling Newline separation intact)',
    types(lexed(gExcept, 'aaa\n--! ship me\nbbb')).join(' ') ===
    'Word:aaa Newline: DocNote:--! ship me Newline: Word:bbb');

  // Default behavior unchanged: without the option, `--!` is swallowed like any `--` line.
  check('commentExcept: absent → introducer+exception lines are still swallowed (back-compat)',
    !lexed(gDefault, 'aaa\n--! gone\nbbb').some(t => t.type === 'DocNote'));

  // The exception is position-sensitive: it must IMMEDIATELY follow the introducer.
  check('commentExcept: `-- !` (space before the exception) is still a comment',
    !lexed(gExcept, 'aaa\n-- ! still a comment\nbbb').some(t => t.type === 'DocNote'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. rawBlock — line-TRAILING introducer captures the indented body verbatim
// ─────────────────────────────────────────────────────────────────────────────
{
  const Indent = token(never(), {});
  const Dedent = token(never(), {});
  const Newline = token(never(), {});
  const RawBody = token(never(), {});
  const Line = rule(() => [[Word, opt('(', many(alt(Word, Str)), ')'), opt(RawBody)], [RawBody]]);
  const Lines = rule(() => [[Line, many(Newline, Line)]]);
  const Doc = rule(() => [[opt(Lines), opt(Indent), opt(Lines), opt(Dedent)]]);

  const mk = (indent: IndentConfig) => defineGrammar({
    name: 'tinyraw', tokens: { Indent, Dedent, Newline, RawBody, Word, Str }, rules: { Line, Lines, Doc }, entry: Doc, indent,
  });
  const base: IndentConfig = {
    indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline',
    flowOpen: ['('], flowClose: [')'],
  };
  const g = mk({ ...base, rawBlock: { token: 'RawBody' } });
  const gOff = mk(base);

  // Core capture: `word:` at end of line takes all MORE-indented lines as ONE token.
  const t1 = lexed(g, 'thing:\n  raw one\n  raw two\nnext');
  check('rawBlock: trailing `:` captures the indented body as ONE token',
    t1.some(t => t.type === 'RawBody' && t.text === ':\n  raw one\n  raw two\n'));
  check('rawBlock: capture ends at dedent — the sibling lexes normally',
    t1.some(t => t.type === 'Word' && t.text === 'next'));

  // Named mode: `word:mode` — the mode word is part of the token (introducer line).
  check('rawBlock: named mode `thing:md` is captured with the introducer',
    lexed(g, 'thing:md\n  body').some(t => t.type === 'RawBody' && t.text.startsWith(':md\n')));

  // Line-lead form: a bare `:mode` at the start of a line.
  check('rawBlock: bare `:mode` at line lead opens a block',
    lexed(g, ':md\n  body').some(t => t.type === 'RawBody'));

  // Blank lines belong to the block; capture still ends at the dedent.
  check('rawBlock: interior blank lines are part of the body',
    lexed(g, 'thing:\n  one\n\n  two\nnext').some(t => t.type === 'RawBody' && t.text.includes('one\n\n  two')));

  // GLUE rule: top-level whitespace before the introducer means it is NOT an
  // introducer (`label size:` is text ending in a colon, not a raw block) …
  check('rawBlock: top-level space before `:` does not open a block', (() => {
    try { return !lexed(g, 'label size:\n  child').some(t => t.type === 'RawBody'); }
    catch { return true; }   // a lex error on the stray `:` is also "did not capture"
  })());
  // … but whitespace INSIDE balanced parens/quotes does not break the glue.
  check('rawBlock: whitespace inside parens keeps the introducer glued',
    lexed(g, 'thing(aa "b b" cc):\n  body').some(t => t.type === 'RawBody'));

  // Mid-line content after the introducer breaks the signature (must run to EOL).
  check('rawBlock: `:` with trailing content on the line is not an introducer', (() => {
    try { return !lexed(g, 'thing: not a block\n  child').some(t => t.type === 'RawBody'); }
    catch { return true; }   // a lex error on the stray `:` is also "did not capture"
  })());

  // Inside flow, the introducer char is inert.
  check('rawBlock: introducer inside parens is inert', (() => {
    try { return !lexed(g, 'thing(aa:\n  bb)').some(t => t.type === 'RawBody'); }
    catch { return true; }   // a lex error is also "did not open a raw block"
  })());

  // Default off: without the config, nothing captures.
  check('rawBlock: absent → no capture (back-compat)', (() => {
    try { return !lexed(gOff, 'thing:\n  raw').some(t => t.type === 'RawBody'); }
    catch { return true; }
  })());

  // The introducer is grammar DATA: a custom signature/char works identically.
  const gCustom = mk({ ...base, rawBlock: { token: 'RawBody', introChar: '=', signature: '=(?:[a-z]+)?[ \\t]*(?:\\r?\\n|$)' } });
  check('rawBlock: custom introducer char/signature is honored (data-driven)',
    lexed(gCustom, 'thing=md\n  body').some(t => t.type === 'RawBody' && t.text.startsWith('=md')));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. flowColonSeparator: false — `:name` tokens survive after values in flow
// ─────────────────────────────────────────────────────────────────────────────
{
  const Indent = token(never(), {});
  const Dedent = token(never(), {});
  const Newline = token(never(), {});
  // Bound-attribute-style token: `:name`
  const BoundName = token(seq(':', plus(lower)), {});
  const Item = rule(() => [Word, Str, BoundName, ['(', many(Item), ')']]);
  const Line = rule(() => [[Word, '(', many(Item), ')']]);
  const Doc = rule(() => [[opt(Line)]]);

  const mk = (indent: IndentConfig) => defineGrammar({
    name: 'tinyflow', tokens: { Indent, Dedent, Newline, Word, Str, BoundName }, rules: { Item, Line, Doc }, entry: Doc, indent,
  });
  const base: IndentConfig = {
    indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline',
    flowOpen: ['('], flowClose: [')'],
  };
  const gYaml = mk(base);                                       // default: YAML behavior
  const gOff = mk({ ...base, flowColonSeparator: false });

  // Default (YAML): a `:` after a quoted value in flow is forced separator punctuation.
  check('flowColonSeparator default: `:` after a string is separator punct (YAML behavior)',
    lexed(gYaml, 'tag("v" :k)').some(t => t.type === '' && t.text === ':'));

  // Disabled: the same `:` starts the BoundName token.
  check('flowColonSeparator false: `:name` after a string lexes as one token',
    lexed(gOff, 'tag("v" :k)').some(t => t.type === 'BoundName' && t.text === ':k'));

  // Same carve-out after a flow-CLOSE delimiter, nested so flow depth stays > 0.
  check('flowColonSeparator false: `:name` after `)` (still in flow) lexes as one token',
    lexed(gOff, 'tag((aa) :k)').some(t => t.type === 'BoundName' && t.text === ':k'));
  check('flowColonSeparator default: `:` after `)` splits (YAML behavior preserved)',
    !lexed(gYaml, 'tag((aa) :k)').some(t => t.type === 'BoundName'));
}

console.log(fail === 0
  ? `\n${ok}/${ok} indent-extension checks pass — commentExcept / rawBlock / flowColonSeparator behave as specified`
  : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
