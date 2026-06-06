// Regression contracts for env-spec-style DSL grammars (originally PR #9, ported to the
// current token-pattern-IR API). These lock down two user-facing behaviors:
//   1. an escaped backtick string keeps backtick delimiters in TextMate (no `"` fallback)
//   2. an indentation grammar WITHOUT `indent.blockScalar` does not enforce YAML multiline
//      quoted-scalar continuation rules (so `KEY="line1\nline2"` parses)
//
// Run with: node test/env-spec-regressions.ts
import { createParser } from '../src/gen-parser.ts';
import { defineGrammar, many, opt, rule, token, seq, star, alt, lit, oneOf, noneOf, anyChar, never, range, plus, followedBy } from '../src/api.ts';
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
    seq(lit('`'), star(alt(seq(lit('\\'), anyChar()), noneOf(oneOf('`', '\\')))), lit('`')),
    { scope: 'string.quoted.other', string: true, escape: seq(lit('\\'), anyChar()) },
  );
  const File = rule(() => [[BT]]);
  const grammar = defineGrammar({ name: 'backtick-string', tokens: { BT }, rules: { File }, entry: File });

  const tm = generateTmLanguage(grammar, 'backtick-string');
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
    seq(oneOf(range('A', 'Z'), '_'), star(oneOf(range('A', 'Z'), range('0', '9'), '_')), followedBy(lit('='))),
    { identifier: true },
  );
  const DQ = token(
    seq(lit('"'), star(alt(seq(lit('\\'), anyChar()), noneOf(oneOf('"', '\\')))), lit('"')),
    { string: true, escape: seq(lit('\\'), anyChar()) },
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

console.log(
  fail === 0
    ? `\n${ok}/${ok} env-spec regression checks pass`
    : `\n${fail} FAILED (of ${ok + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
