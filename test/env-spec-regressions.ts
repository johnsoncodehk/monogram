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
import { generateTreeSitter } from '../src/gen-treesitter.ts';

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
// Regressions 3–6: structured-comment highlighting — BEHAVIORAL SPEC.
//
// These are written against the *rendered output* (vscode-textmate tokenization
// of a real document), not the generated grammar's internal shape, so they pin
// the desired outcome independently of how the generators achieve it.
//
// The dialect under test is an env-spec-style DSL: comments carry a decorator
// DSL, so the PARSER must tokenize comment bodies — but a comment is still a
// comment to a THEME. The contract, line by line:
//
//   KEY=fn(retry=3, plain)         KEY = env key; retry = option key (attribute,
//                                  contextualScopes); plain = positional value
//   # a note with **bold** mark    prose dims as comment; **bold** = markup
//   # @dec(opt=1)                  decorator comments keep rich token scopes
//   # @import(                     an OPEN bracket continues the construct
//   #   first,                     across `#`-prefixed lines: content keeps its
//   #   pick=[                     token scopes; the line-start `#` is a
//   #     ITEM, # aside            continuation marker; `# aside` dims to EOL
//   #   ],
//   # )
//   # after                        construct closed → plain dim comment again
//
// And all of it is HIGHLIGHT-ONLY: the parser must produce a byte-identical
// CST whether or not the highlight metadata is declared.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onigLib from 'vscode-oniguruma';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onigLib;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function makeDialect(withHighlightMetadata: boolean) {
  const hspace = oneOf(' ', '\t');
  const alnum = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'));
  const WS = token(plus(hspace), { skip: true, scope: 'meta.whitespace' });
  const DEC_NAME = token(seq('@', plus(alnum)), { scope: 'variable.annotation' });
  const HASH = token(seq(notPrecededBy(noneOf(' ', '\t', '\n', '\r')), '#'), {
    scope: 'comment.line',
    ...(withHighlightMetadata ? {
      lineComment: {
        richStarters: [DEC_NAME],
        continuationBrackets: [['(', ')'], ['[', ']']] as [string, string][],
        markup: [{ pattern: seq('**', star(noneOf('*', '\n')), '**'), scope: 'markup.bold' }],
      },
    } : {}),
  });
  const KEY = token(seq(plus(alnum), followedBy('=')), { scope: 'entity.name.tag' });
  const FN_NAME = token(seq(plus(alnum), followedBy(seq(star(hspace), '('))), { scope: 'variable.function' });
  const TEXT = token(plus(noneOf(' ', '\t', '\n', '#', '=', '@', '(', ')', '[', ']', ',', '*')), { scope: 'string.unquoted' });
  const ArgKV = rule(() => [[KEY, '=', TEXT]]);
  const Arg = rule(() => [ArgKV, TEXT]);
  const Args = rule(() => [['(', opt(Arg), opt(','), opt(Arg), ')']]);
  const Call = rule(() => [[FN_NAME, Args]]);
  const Part = rule(() => [DEC_NAME, Call, ArgKV, TEXT, KEY, '=', ',', '(', ')', '[', ']', '**']);
  const Comment = rule(() => [[HASH, many(Part)]]);
  const Item = rule(() => [[KEY, '=', Call, opt(Comment)]]);
  const Line = rule(() => [Item, Comment]);
  const File = rule(() => [[many(Line)]]);
  return defineGrammar({
    name: 'env-spec-dialect',
    tokens: { WS, HASH, DEC_NAME, KEY, FN_NAME, TEXT },
    rules: { ArgKV, Arg, Args, Call, Part, Comment, Item, Line, File },
    ...(withHighlightMetadata ? {
      contextualScopes: [{ token: KEY, within: [ArgKV], scope: 'entity.other.attribute-name' }],
    } : {}),
    entry: File,
  });
}

const DOC = [
  'KEY=fn(retry=3, plain)',
  '# a note with **bold** mark',
  '# @dec(opt=1)',
  '# @import(',
  '#   first,',
  '#   pick=[',
  '#     ITEM, # aside',
  '#   ],',
  '# )',
  '# after',
];

async function tokenizeDoc(grammarDef: ReturnType<typeof makeDialect>) {
  const tm = generateTmLanguage(grammarDef);
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new OnigScanner(p),
      createOnigString: (str: string) => new OnigString(str),
    }),
    loadGrammar: async (scopeName: string) => scopeName === 'source.env-spec-dialect'
      ? parseRawGrammar(JSON.stringify(tm), 'g.json') : null,
  });
  const grammar = (await registry.loadGrammar('source.env-spec-dialect'))!;
  let stack = INITIAL;
  return DOC.map((line) => {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
}

type Span = { text: string; scopes: string[] };
// the scopes painted on `text` in DOC line `lineNo` (1-based); nth occurrence via `skip`
function paint(lines: Span[][], lineNo: number, text: string, skip = 0): string[] {
  let seen = 0;
  for (const span of lines[lineNo - 1]) {
    if (span.text.includes(text) || (text.length > span.text.length && span.text.trim() !== '' && text.includes(span.text.trim()) && span.text.trim().length > 2)) {
      if (seen === skip) return span.scopes;
      seen += 1;
    }
  }
  return [];
}
const has = (scopes: string[], frag: string) => scopes.some((sc) => sc.includes(frag));

{
  const lines = await tokenizeDoc(makeDialect(true));

  // ── Regression 3: contextual scopes — the SAME token, three different paints ──
  check('spec: a top-level env key keeps its declared scope', has(paint(lines, 1, 'KEY'), 'entity.name.tag'));
  check('spec: an option key inside call args paints as an attribute name', has(paint(lines, 1, 'retry'), 'entity.other.attribute-name'));
  check('spec: a positional arg value is NOT an attribute name', !has(paint(lines, 1, 'plain'), 'attribute-name') && has(paint(lines, 1, 'plain'), 'string.unquoted'));
  check('spec: the callee keeps its function scope', has(paint(lines, 1, 'fn'), 'function'));

  // ── Regression 4: plain comments dim; markup highlights ──
  check('spec: plain comment prose paints as comment, not as a value string', has(paint(lines, 2, 'a note with'), 'comment.line') && !has(paint(lines, 2, 'a note with'), 'string.unquoted'));
  check('spec: the comment introducer is comment punctuation', has(paint(lines, 2, '#'), 'punctuation.definition.comment'));
  check('spec: declared markup highlights inside plain comments', has(paint(lines, 2, '**bold**'), 'markup.bold'));

  // ── Regression 5: decorator comments stay rich ──
  check('spec: a decorator in a rich comment keeps its annotation scope', has(paint(lines, 3, '@dec'), 'variable.annotation'));
  check('spec: an option key inside a decorator call paints as an attribute name', has(paint(lines, 3, 'opt'), 'entity.other.attribute-name'));

  // ── Regression 6: multi-line constructs — an open bracket continues the construct ──
  check('spec: construct content on a continuation line keeps its token scope (not dimmed)', has(paint(lines, 5, 'first'), 'string.unquoted'));
  check('spec: the line-start `#` inside a construct is a continuation marker (comment punctuation)', has(paint(lines, 5, '#'), 'punctuation.definition.comment'));
  check('spec: a nested option key on a continuation line paints as an attribute name', has(paint(lines, 6, 'pick'), 'entity.other.attribute-name'));
  check('spec: a nested array element keeps its token scope', has(paint(lines, 7, 'ITEM'), 'string.unquoted'));
  check('spec: an embedded `# aside` after content dims to end-of-line', has(paint(lines, 7, 'aside'), 'comment.line') && !has(paint(lines, 7, 'aside'), 'string.unquoted'));
  check('spec: after the construct closes, a plain comment dims again', has(paint(lines, 10, 'after'), 'comment.line') && !has(paint(lines, 10, 'after'), 'string.unquoted'));
}

// ── Highlight metadata is HIGHLIGHT-ONLY: identical CSTs with and without it ──
{
  const withMeta = createParser(makeDialect(true));
  const withoutMeta = createParser(makeDialect(false));
  const text = DOC.join('\n');
  const a = JSON.stringify(withMeta.parse(text));
  const b = JSON.stringify(withoutMeta.parse(text));
  check('spec: the parser CST is byte-identical with and without highlight metadata', a === b);
}

// ── Without the metadata, generation is unchanged (the features are opt-in) ──
{
  const plainGrammar = makeDialect(false);
  const tm = generateTmLanguage(plainGrammar);
  check('spec: without lineComment metadata the comment token stays a flat match', typeof tm.repository.hash?.match === 'string' && tm.repository.hash?.begin === undefined);
  check('spec: without contextualScopes no construct regions are derived', !Object.keys(tm.repository).some((k) => k.startsWith('ctx-')));
}

// ── tree-sitter: the same contextualScopes declaration becomes exact queries ──
{
  const ts = generateTreeSitter(makeDialect(true), 'env-spec-dialect');
  check('spec: tree-sitter emits an exact rule-scoped capture for the contextual scope', ts.highlightsScm.includes('(arg_kv (key) @attribute)'));
  check('spec: contextual captures come last (highlight resolution is last-wins)', ts.highlightsScm.lastIndexOf('(arg_kv (key) @attribute)') > ts.highlightsScm.lastIndexOf('] @'));
}

console.log(
  fail === 0
    ? `\n${ok}/${ok} env-spec regression checks pass`
    : `\n${fail} FAILED (of ${ok + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
