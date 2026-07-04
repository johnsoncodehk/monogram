// Regression contracts for env-spec-style DSL grammars (originally PR #9, ported to the
// current token-pattern-IR API). These lock down two user-facing behaviors:
//   1. an escaped backtick string keeps backtick delimiters in TextMate (no `"` fallback)
//   2. an indentation grammar WITHOUT `indent.blockScalar` does not enforce YAML multiline
//      quoted-scalar continuation rules (so `KEY="line1\nline2"` parses)
//
// Run with: node test/env-spec-regressions.ts
import { createParser } from '../src/gen-parser.ts';
import { defineGrammar, many, opt, rule, token, seq, star, altPattern, oneOf, noneOf, anyChar, never, range, plus, followedBy, notPrecededBy } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';

let ok = 0;
let fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}`); }
};

// ---------------------------------------------------------------------------
// Regression 1: escaped backtick strings keep backtick delimiters in TextMate.
//   token pattern: `(?:\\.|[^`\\])*`   escape: \\.
// ---------------------------------------------------------------------------
{
  const BT = token(
    seq('`', star(altPattern(seq('\\', anyChar()), noneOf(oneOf('`', '\\')))), '`'),
    { scope: 'string.quoted.other', string: true, escape: seq('\\', anyChar()) },
  );
  const File = rule(() => [[BT]]);
  const grammar = defineGrammar({ name: 'backtick-string', tokens: { BT }, rules: { File }, entry: File });

  const tm = generateTmLanguage(grammar);
  const btRepo = tm.repository.bt;
  check('tm: backtick token repository entry exists', !!btRepo);
  check('tm: backtick token begin delimiter is `', btRepo?.begin === '`');
  check('tm: backtick token end delimiter is `|$', btRepo?.end === '`|$');
}

// ---------------------------------------------------------------------------
// Regression 2: indentation grammars without blockScalar must NOT enforce YAML
// multiline quoted-scalar indentation rules.
// ---------------------------------------------------------------------------
{
  const WS = token(plus(oneOf(' ', '\t')), { skip: true });
  const INDENT = token(never(), {});
  const DEDENT = token(never(), {});
  const NEWLINE = token(never(), {});
  // KEY is `[A-Z_][A-Z0-9_]*` immediately followed by `=` (a lookahead).
  const KEY = token(
    seq(oneOf(range('A', 'Z'), '_'), star(oneOf(range('A', 'Z'), range('0', '9'), '_')), followedBy('=')),
    { identifier: true },
  );
  const DQ = token(
    seq('"', star(altPattern(seq('\\', anyChar()), noneOf(oneOf('"', '\\')))), '"'),
    { string: true, escape: seq('\\', anyChar()) },
  );

  const Value = rule(() => [[DQ]]);
  const Statement = rule(() => [[KEY, '=', Value, opt(NEWLINE)]]);
  const File = rule(() => [[many(Statement)]]);

  const grammar = defineGrammar({
    name: 'indent-no-blockscalar',
    tokens: { WS, INDENT, DEDENT, NEWLINE, KEY, DQ },
    rules: { Value, Statement, File },
    indent: {
      indentToken: 'INDENT',
      dedentToken: 'DEDENT',
      newlineToken: 'NEWLINE',
      flowOpen: ['('],
      flowClose: [')'],
    },
    entry: File,
  });

  const parser = createParser(grammar);
  let threw = false;
  try {
    // Regressed when YAML block-scalar continuation checks ran for ALL indentation grammars: KEY="a\nb"
    parser.parse('KEY="line1\nline2"');
  } catch {
    threw = true;
  }
  check('parser: multiline inline quoted value is accepted without blockScalar', !threw);
}

// ---------------------------------------------------------------------------
// Regression 3: a line-comment INTRODUCER token (`lineComment` metadata) emits
// to-end-of-line REGIONS in TextMate, not a flat 1-char rule — so comment prose
// dims to the comment scope while `richStarters`-led comments (env-spec decorator
// comments `# @dec(...)`) keep full token highlighting inside.
// ---------------------------------------------------------------------------
{
  const hspace = oneOf(' ', '\t');
  const alpha = oneOf(range('a', 'z'), range('A', 'Z'));
  const WS = token(plus(hspace), { skip: true, scope: 'meta.whitespace' });
  const DEC_NAME = token(seq('@', plus(alpha)), { scope: 'variable.annotation' });
  const HASH = token(seq(notPrecededBy(noneOf(' ', '\t', '\n', '\r')), '#'), {
    scope: 'comment.line',
    lineComment: { richStarters: [DEC_NAME] },
  });
  const KEY = token(seq(plus(alpha), followedBy('=')), { scope: 'entity.name.tag' });
  const TEXT = token(plus(noneOf(' ', '\t', '\n', '#', '=', '@')), { scope: 'string.unquoted' });
  const Part = rule(() => [DEC_NAME, TEXT]);
  const Comment = rule(() => [[HASH, many(Part)]]);
  const Item = rule(() => [[KEY, '=', opt(TEXT), opt(Comment)]]);
  const Line = rule(() => [Item, Comment]);
  const File = rule(() => [[many(Line)]]);
  const grammar = defineGrammar({
    name: 'env-spec-comments',
    tokens: { WS, HASH, DEC_NAME, KEY, TEXT },
    rules: { Part, Comment, Item, Line, File },
    entry: File,
  });

  const tm = generateTmLanguage(grammar);
  const plain = tm.repository.hash;
  const rich = tm.repository['hash-rich'];
  check('tm: plain comment entry is a to-EOL region', !!plain && plain.end === '$');
  check('tm: plain comment region carries the comment scope', plain?.name === 'comment.line.env-spec-comments');
  check('tm: plain comment region has NO inner patterns (prose dims)', Array.isArray(plain?.patterns) && plain.patterns.length === 0);
  check('tm: rich comment entry exists and is gated on the rich starter', !!rich && typeof rich.begin === 'string' && rich.begin.includes('(?=[ \\t]*'));
  check('tm: rich comment region keeps full token highlighting via $self', JSON.stringify(rich?.patterns) === JSON.stringify([{ include: '$self' }]));
  check('tm: rich entry is tried before the plain entry', (() => {
    const order = tm.patterns.map((p) => (p as { include?: string }).include);
    return order.indexOf('#hash-rich') !== -1 && order.indexOf('#hash-rich') < order.indexOf('#hash');
  })());
  check('tm: introducer captures as comment punctuation', JSON.stringify(plain?.beginCaptures?.['1']) === JSON.stringify({ name: 'punctuation.definition.comment.env-spec-comments' }));

  // parser behavior is UNaffected by the highlight-only metadata
  const parser = createParser(grammar);
  let threw = false;
  try {
    parser.parse('KEY=val # @dec note\n# plain prose');
  } catch {
    threw = true;
  }
  check('parser: lineComment metadata does not change parsing', !threw);

  // a comment token WITHOUT the metadata still emits the flat rule (no behavior change)
  const HASH2 = token(seq(notPrecededBy(noneOf(' ', '\t', '\n', '\r')), '#'), { scope: 'comment.line' });
  const Comment2 = rule(() => [[HASH2, many(TEXT)]]);
  const File2 = rule(() => [[many(Comment2)]]);
  const flatGrammar = defineGrammar({ name: 'no-metadata', tokens: { HASH2, TEXT }, rules: { Comment2, File2 }, entry: File2 });
  const tm2 = generateTmLanguage(flatGrammar);
  check('tm: without lineComment metadata the comment token stays a flat match', typeof tm2.repository.hash2?.match === 'string' && tm2.repository.hash2?.begin === undefined);
}

console.log(
  fail === 0
    ? `\n${ok}/${ok} env-spec regression checks pass`
    : `\n${fail} FAILED (of ${ok + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
