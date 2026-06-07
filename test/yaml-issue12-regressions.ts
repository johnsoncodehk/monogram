// yaml-issue12-regressions.ts — the ten YAML highlighting repros RedCMD filed in the
// johnsoncodehk/monogram#12 comment (issuecomment-4640869820), encoded as asserted SHOULD-BE scopes.
//
// Each case asserts the GENUINELY-correct rendering of the marked span — derived from the YAML spec
// and the independent `yaml`-package CST (see yaml-oracle.ts), NOT from "whatever Monogram emits" and
// NOT from the co-biased hand-rolled oracle that originally let these through. This is the lock that
// keeps a fixed bug fixed, and a precise spec for the ones still open.
//
// Cases flagged `bug: true` are KNOWN-failing today (the real defects this corpus exists to surface);
// the runner lists them as fix-targets but does NOT fail on them. A case WITHOUT `bug` that fails is a
// real regression → non-zero exit. Run (bare node): node test/yaml-issue12-regressions.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

export interface Issue12Case {
  id: string;            // monogram#12 item number
  title: string;
  src: string;           // a minimal repro from the comment
  at: string;            // a substring locating the marked span
  col?: number;          // offset into `at` of the exact char to check (default 0)
  nth?: number;          // which occurrence of `at` (1-based, default 1)
  should: (scope: string) => boolean;   // the genuinely-correct scope predicate
  why: string;           // the spec/CST reason this is the correct answer
  bug?: boolean;         // currently FAILS in Monogram — a fix target, not a regression
}

// scope predicates (positive: what it SHOULD be; the bug is always the negation)
const isComment = (s: string) => /comment/.test(s);
const notComment = (s: string) => !/comment/.test(s);
const isString = (s: string) => /string/.test(s);
const isBlockString = (s: string) => /string\.unquoted\.block|string\.unquoted|keyword\.control\.flow\.block-scalar/.test(s);
const notTag = (s: string) => !/storage\.type\.tag|\btag\.type|entity\.name\.tag\b.*tag/.test(s) && !/storage\.type\.tag/.test(s);
const notNumber = (s: string) => !/constant\.numeric/.test(s);
const notDirective = (s: string) => !/keyword\.other\.directive/.test(s);
const notFlowPunct = (s: string) => !/punctuation\.separator|punctuation\.definition\.(sequence|mapping)/.test(s);
const isDirectiveish = (s: string) => /keyword\.other\.directive|support|storage\.type|string\.unquoted\.directive|constant\.numeric/.test(s);
const isEscapeOrInvalid = (s: string) => /constant\.character\.escape|invalid/.test(s);

export const cases: Issue12Case[] = [
  { id: '#1', title: '`,` inside an `ns-global-tag-prefix` is directive content, not flow punctuation',
    src: '%TAG !e! tag:example.com,2000:app/\n', at: ',2000', col: 0,
    should: (s) => notFlowPunct(s), why: 'the `,` is inside the %TAG directive\'s tag-prefix → CST emits one `directive` token; a flow separator is wrong' },

  { id: '#2', title: '`!` inside a comment is comment text, not a tag',
    src: '  # Use the ! handle for presenting\n', at: '! handle', col: 0,
    should: (s) => isComment(s), why: 'CST emits one `comment` token spanning `# … ! …`; the `!` is comment content, not storage.type.tag' },

  { id: '#3', title: 'a duplicate `%YAML` directive is still highlighted normally as a directive',
    src: '%YAML 1.2\n%YAML 1.2\n---\n', at: '%YAML', col: 1, nth: 2,
    should: (s) => isDirectiveish(s), why: 'RedCMD: the duplicate is an LSP-level error but should still be highlighted as a directive, not dropped' },

  { id: '#4', title: '`%YAML 1.2 foo` — the trailing param is part of the directive line',
    src: '%YAML 1.2 foo\n---\n', at: 'foo', col: 0,
    should: (s) => isDirectiveish(s), why: 'CST emits one `directive` token `%YAML 1.2 foo`; the trailing token is directive content, not a stray plain string.unquoted scalar', bug: true },

  { id: '#5', title: 'an escape inside a double-quoted scalar is highlighted',
    src: 'double: "quoted \\\' scalar"\n', at: "\\'", col: 0,
    should: (s) => isEscapeOrInvalid(s), why: '`\\\'` in a double-quoted scalar is an (invalid) escape; it should be constant.character.escape or invalid, not plain string', bug: true },

  { id: '#6', title: 'a `!` opening a plain-scalar CONTINUATION line is string content, not a tag',
    src: 'safe: a!"#$%&\'()*+,-./09:;<=>?@AZ\n     !"#$%&\'()*+,-./09:;<=>?@AZ\n', at: '     !', col: 5,
    should: (s) => isString(s), why: 'the 2nd line folds into the one multi-line plain scalar (CST: one `scalar` token); the leading `!` is content, not storage.type.tag', bug: true },

  { id: '#7', title: '`42` inside a multi-line plain-scalar KEY is string content, not a number',
    src: '? a\n  true\n: null\n  d\n? e\n  42\n', at: '  42', col: 2,
    should: (s) => notNumber(s), why: 'the explicit key is the plain scalar "e 42" (CST/AST: one scalar that resolves to the STRING "e 42"); `42` is not a numeric literal', bug: true },

  { id: '#8', title: '`#...` immediately after `%YAML 1.1` is directive content, not a comment',
    src: '%YAML 1.1#...\n', at: '#...', col: 0,
    should: (s) => notComment(s), why: 'no whitespace precedes the `#`, so it is not a comment; CST emits one `directive` token `%YAML 1.1#...`', bug: true },

  { id: '#9', title: '`%YAML` after document content is plain-scalar text, not a directive',
    src: '---\nscalar\n%YAML 1.2\n', at: '%YAML', col: 0,
    should: (s) => notDirective(s) && isString(s), why: 'a directive cannot appear after content; `scalar\\n%YAML 1.2` folds into one plain scalar (CST: one `scalar` token)', bug: true },

  { id: '#10', title: 'a `#` line inside a `|5` block scalar body is string content, not a comment',
    src: 'abc: |5\n      # string 6\n     # string 5\n    #comment 4\n   #comment 3\n', at: '# string 5', col: 0,
    should: (s) => isBlockString(s), why: 'with explicit indent 5, the `# string 5` line (indent 5) is block-scalar body; CST puts it inside the `block-scalar`, only `#comment 4` (indent 4 < 5) ends it', bug: true },
];

// ── runner ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { INITIAL, Registry, parseRawGrammar } = vsctm;
  const { loadWASM, OnigScanner, OnigString } = onig;
  const require = createRequire(import.meta.url);
  const bin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await loadWASM(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => (sn === 'source.yaml' ? parseRawGrammar(readFileSync('yaml.tmLanguage.json', 'utf-8'), 'yaml.json') : null),
  });
  const grammar = await reg.loadGrammar('source.yaml');
  if (!grammar) { console.error('failed to load yaml.tmLanguage.json (run: node src/cli.ts yaml.ts)'); process.exit(1); }

  const scopeAt = (text: string, pos: number): string => {
    const lines = text.split('\n'); let rs = INITIAL, off = 0;
    for (const line of lines) {
      const r = grammar.tokenizeLine(line, rs);
      if (pos >= off && pos < off + line.length) { for (const t of r.tokens) if (off + t.startIndex <= pos && pos < off + t.endIndex) return t.scopes[t.scopes.length - 1]; }
      rs = r.ruleStack; off += line.length + 1;
    }
    return '(none)';
  };
  const locate = (c: Issue12Case): number => {
    let from = -1; for (let i = 0; i < (c.nth ?? 1); i++) from = c.src.indexOf(c.at, from + 1);
    return from < 0 ? -1 : from + (c.col ?? 0);
  };

  let regressions = 0, knownBugs = 0, pass = 0;
  console.log('YAML monogram#12 repros — asserted SHOULD-BE scopes:\n');
  for (const c of cases) {
    const pos = locate(c);
    const scope = pos < 0 ? '(mark not found)' : scopeAt(c.src, pos);
    const ok = pos >= 0 && c.should(scope);
    const tag = ok ? 'PASS' : c.bug ? 'KNOWN-BUG' : 'REGRESSION';
    if (ok) pass++; else if (c.bug) knownBugs++; else regressions++;
    console.log(`  ${tag.padEnd(11)} ${c.id.padEnd(4)} ${c.title}`);
    console.log(`              got «${scope}»  — ${c.why}`);
  }
  console.log(`\n  ${pass} pass · ${knownBugs} known-bug (fix targets) · ${regressions} regression`);
  if (regressions) { console.error(`\n✗ ${regressions} case(s) that previously held now regressed.`); process.exit(1); }
  console.log('\n✓ no regressions (known bugs are expected to fail until fixed).');
}
