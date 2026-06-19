// Indent-mode extensions for non-YAML indentation languages, specified as
// engine behavior over TOY grammars (token names and introducer characters
// deliberately unlike any real language — the behaviors are grammar DATA).
//
// Opt-in IndentConfig fields, each motivated by a non-YAML indentation language
// (one that nests HTML-ish tag lines or `k=v` entries rather than YAML scalars):
//
//   1. `commentExcept`             — two-tier comments: `--` lines vanish (like
//                                    YAML `#`), but `--!` lines are REAL tokens.
//   2. `rawBlock`                  — verbatim capture introduced from the END of
//                                    a line (Pug-style); mirror of `blockScalar`.
//   3. `flowSeparatorAfterTokens`  — EXPLICIT membership for the flow `:` key/
//                                    value carve-out, decoupled from `string`
//                                    (issue #44 (A)). OFF unless declared.
//   4. `foldTokens`                — EXPLICIT membership for plain-scalar
//                                    continuation folding, decoupled from
//                                    `blockPattern` (issue #44 (B)). OFF unless
//                                    declared.
//   5. `keyValueSeparator`         — the separator glyph the LEXER (not just
//                                    gen-tm) reads for key-line sniffs; a non-`:`
//                                    value is recognized structurally (issue
//                                    #44 (C)). Default ':'.
//
// All default OFF / neutral — a grammar declaring none (YAML opts in field-by-
// field) tokenizes byte-identically, which the yaml gates already enforce.
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
// 3. flowSeparatorAfterTokens — flow `:` carve-out is EXPLICIT membership, OFF by
//    default, and DECOUPLED from the `string` flag (issue #44 (A) un-overload).
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
  // `Str` carries `string: true` (region scoping). NEUTRAL grammar = no flowSeparatorAfterTokens
  // declared. ROOT-CAUSE PROOF: under the old derivation `string: true` alone enlisted `Str` into the
  // carve-out; after the un-overload it does NOT — the `:k` survives as one BoundName token.
  const gNeutral = mk(base);
  // Opt IN explicitly: name `Str` (and flow-close is then active too).
  const gOn = mk({ ...base, flowSeparatorAfterTokens: ['Str'] });

  check('flowSeparatorAfterTokens: a `string:true` token is NOT auto-enlisted — `:name` survives after a string',
    lexed(gNeutral, 'tag("v" :k)').some(t => t.type === 'BoundName' && t.text === ':k'));
  check('flowSeparatorAfterTokens: neutral grammar — `:name` survives after a flow-close `)` too',
    lexed(gNeutral, 'tag((aa) :k)').some(t => t.type === 'BoundName' && t.text === ':k'));

  // Declared: the same `:` after the named token is now forced separator punctuation.
  check('flowSeparatorAfterTokens: declared → `:` after the named token is separator punct',
    lexed(gOn, 'tag("v" :k)').some(t => t.type === '' && t.text === ':') &&
    !lexed(gOn, 'tag("v" :k)').some(t => t.type === 'BoundName'));
  // Declaring the carve-out also activates it after a flow-CLOSE delimiter.
  check('flowSeparatorAfterTokens: declared → `:` after flow-close `)` also splits',
    lexed(gOn, 'tag((aa) :k)').some(t => t.type === '' && t.text === ':') &&
    !lexed(gOn, 'tag((aa) :k)').some(t => t.type === 'BoundName'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. foldTokens — plain-scalar continuation fold is EXPLICIT membership, OFF by
//    default, and DECOUPLED from the `blockPattern` flag (issue #44 (B) un-overload).
// ─────────────────────────────────────────────────────────────────────────────
{
  const Indent = token(never(), {});
  const Dedent = token(never(), {});
  const Newline = token(never(), {});
  // A token that DECLARES a block-context variant via `blockPattern`. Its head pattern is `[a-z]+`, so
  // a line that STARTS with `-` cannot be lexed as a Scalar. Under the old derivation any blockPattern
  // token got YAML plain-scalar folding; after the un-overload it does not, unless named in foldTokens.
  const Scalar = token(plus(lower), { scope: 'scalar', blockPattern: plus(lower) });
  const Line = rule(() => [[Scalar, many(Newline, Scalar)]]);
  const Lines = rule(() => [[Line, many(Newline, Line)]]);
  const Doc = rule(() => [[opt(Lines), opt(Indent), opt(Lines), opt(Dedent)]]);

  const mk = (indent: IndentConfig) => defineGrammar({
    name: 'tinyfold', tokens: { Indent, Dedent, Newline, Scalar }, rules: { Line, Lines, Doc }, entry: Doc, indent,
  });
  const base: IndentConfig = { indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline' };
  const gNeutral = mk(base);                                    // blockPattern present, foldTokens absent
  const gFold = mk({ ...base, foldTokens: ['Scalar'] });        // opt IN

  // ROOT-CAUSE PROOF: a deeper line `- bbb` (leading `-`, not a Scalar head) after a `blockPattern`
  // LEAF. With folding OFF (the un-overload — blockPattern alone no longer triggers it) the `-` is an
  // unlexable char → a hard lex error. So the block-context fold genuinely does NOT fire here.
  let neutralThrew = false;
  try { lexed(gNeutral, 'aaa\n  - bbb'); } catch { neutralThrew = true; }
  check('foldTokens: a `blockPattern` token is NOT auto-folded — an illegal-head deeper line errors',
    neutralThrew);

  // Declared: the same input folds — the whole deeper line (its leading `-` is now scalar content) is
  // absorbed as ONE continuation Scalar token. Observed: `Scalar:aaa Indent Scalar:"- bbb" Dedent`.
  const tFold = lexed(gFold, 'aaa\n  - bbb');
  check('foldTokens: declared → the illegal-head deeper line folds into one continuation Scalar',
    tFold.some(t => t.type === 'Scalar' && t.text === '- bbb'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. keyValueSeparator — the lexer (not just gen-tm) reads the separator glyph;
//    a non-`:` separator is recognized structurally by the parser (issue #44 (C)).
// ─────────────────────────────────────────────────────────────────────────────
{
  const Indent = token(never(), {});
  const Dedent = token(never(), {});
  const Newline = token(never(), {});
  // A key scalar whose block variant ends at the `=` separator, and a plain value scalar. The fold
  // sniff (`lineHasKeySeparator`) must treat `=` (not `:`) as the structural key separator so a
  // `k= v` line is a mapping line, not a foldable plain continuation.
  const Key = token(plus(lower), { scope: 'key', blockPattern: seq(plus(lower), '=') });
  const Val = token(plus(lower), { scope: 'val', blockPattern: plus(lower) });
  const Sep = token('=', {});
  const Entry = rule(() => [[Key, Sep, Val]]);
  const Lines = rule(() => [[Entry, many(Newline, Entry)]]);
  const Doc = rule(() => [[opt(Lines), opt(Indent), opt(Lines), opt(Dedent)]]);

  const mk = (indent: IndentConfig) => defineGrammar({
    name: 'tinykv', tokens: { Indent, Dedent, Newline, Key, Val, Sep }, rules: { Entry, Lines, Doc }, entry: Doc, indent,
  });
  // `=` is the separator AND a fold token list so a deeper `k= v` is recognized as a key line, not a fold.
  const g = mk({ indentToken: 'Indent', dedentToken: 'Dedent', newlineToken: 'Newline', keyValueSeparator: '=', foldTokens: ['Key', 'Val'] });

  // A `=`-led line after a plain leaf is a mapping line (the key separator), so it must NOT fold —
  // the lexer's key-separator sniff has to read `=`, not `:`. (If it still hardcoded `:`, the `b= c`
  // line would be seen as separator-less plain content and wrongly fold into one continuation token.)
  // Observed: `Val:a  Indent  Key:"b="  Val:c  Dedent` — `b=` lexes via the block variant as a Key.
  const t = lexed(g, 'a\n  b= c');
  check('keyValueSeparator: the lexer recognizes `=` as the structural separator (`b=` is a Key line, no fold)',
    t.some(tk => tk.type === 'Key' && tk.text === 'b=') &&
    t.some(tk => tk.type === 'Val' && tk.text === 'a') &&          // `a` stayed its own leaf — not folded
    !t.some(tk => tk.type === 'Val' && tk.text.includes('b')));    // `b=` did not fold into a Val continuation
  // Sanity: with NO `=`, the same-shape deeper plain line IS a foldable continuation — proving the
  // first case's non-fold is the `=` separator's doing, not folding being off. The block-context fold
  // emits the deeper line as ONE continuation token (`Val:"b c"`), so it is not two Val tokens.
  const t2 = lexed(g, 'a\n  b c');
  check('keyValueSeparator: a separator-less deeper line still folds into one continuation token',
    t2.some(tk => tk.type === 'Val' && tk.text === 'b c'));
}

console.log(fail === 0
  ? `\n${ok}/${ok} indent-extension checks pass — commentExcept / rawBlock / flowSeparatorAfterTokens / foldTokens / keyValueSeparator behave as specified`
  : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
