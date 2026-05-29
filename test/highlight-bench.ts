// ─────────────────────────────────────────────────────────────────────────────
//  highlight-bench.ts — absolute syntactic-highlighting correctness, both ways.
//
//  Measures, for the OFFICIAL TextMate grammar and for MONOGRAM's generated one,
//  what fraction of the language's distinct highlighting decisions each renders
//  correctly — graded against a neutral tsc-derived oracle, ceiling 100%.
//
//  Design (see the conversation that produced it):
//   • Oracle  = tsc parser only (createSourceFile + token walk). NEVER Monogram's
//               CST, never the official grammar. tsc is the independent third party.
//   • Grading = role granularity via the frozen neutral table in scope-roles.ts.
//   • Two corpora, each answering a different question:
//       – parser conformance (/tmp/ts-repo .../parser): breadth. Denominator =
//         distinct CELLS (role,context), so corpus redundancy can't inflate ("灌水").
//       – adversarial bug ledger (test/issue-cases.ts): the documented official-grammar
//         issues, graded PER ISSUE — the denominator the bug tracker itself defines.
//   • Reports: per-issue handled %, verified Monogram fixes (official wrong / Mono
//     right), per-snippet, per-cell, token accuracy, and a self-audit of every miss.
//
//  Run:
//    node test/highlight-bench.ts                       # both corpora
//    node test/highlight-bench.ts --corpus adversarial  # documented bug ledger only
//    node test/highlight-bench.ts --write-readme        # regenerate the README block
//    node test/highlight-bench.ts --debug 'typeof x < y'  # audit one snippet
//    node test/highlight-bench.ts --gran role|parent|parent2   # context-granularity knob
//
//  Official grammar path override:  MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { R, ROLE_SPEC, gradeScope, isCorrect, normScope } from './scope-roles.ts';
import type { RoleName, Verdict } from './scope-roles.ts';
import { tests as issueTests, multiLineTests as issueMultiLine } from './issue-cases.ts';

const normScopeShort = (s: string): string => (s ? normScope(s) : '(none)');

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = getFlag('--limit') ? parseInt(getFlag('--limit')!, 10) : Infinity;
const GRAN = (getFlag('--gran') ?? 'parent') as 'role' | 'parent' | 'parent2';
const DEBUG_CODE = getFlag('--debug');

const PARSER_DIR = '/tmp/ts-repo/tests/cases/conformance/parser';
const OFFICIAL_PATH =
  process.env.MONOGRAM_OFFICIAL_TM ??
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json';
const MONOGRAM_PATH = 'examples/typescript.tmLanguage.json';

// ── TextMate grammar loading (vscode-textmate + oniguruma) ───────────────────
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function makeRegistry(scopeName: string, content: string): vsctm.Registry {
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  });
}

if (!existsSync(OFFICIAL_PATH)) {
  console.error(`Official grammar not found at:\n  ${OFFICIAL_PATH}\nSet MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json`);
  process.exit(1);
}
if (!existsSync(MONOGRAM_PATH)) {
  console.error(`Monogram grammar not found at ${MONOGRAM_PATH}. Run: node src/cli.ts examples/typescript.ts`);
  process.exit(1);
}

const officialGrammar = await makeRegistry('source.ts', readFileSync(OFFICIAL_PATH, 'utf-8')).loadGrammar('source.ts');
const monogramGrammar = await makeRegistry('source.typescript', readFileSync(MONOGRAM_PATH, 'utf-8')).loadGrammar('source.typescript');
if (!officialGrammar || !monogramGrammar) throw new Error('failed to load a grammar');

const GRAMMARS: { key: 'official' | 'monogram'; g: vsctm.IGrammar }[] = [
  { key: 'official', g: officialGrammar },
  { key: 'monogram', g: monogramGrammar },
];

// ── the ORACLE: tsc → per-token (span, role) ──────────────────────────────────
interface GoldToken {
  start: number;
  end: number;
  text: string;
  role: RoleName;
  cat: 'id' | 'lit' | 'kw' | 'punct' | 'comment';
  parentKind: string;
  grandKind: string;
}

const KW_CONTROL = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'throw', 'try', 'catch', 'finally', 'with', 'debugger']);
const KW_OPERATOR = new Set(['typeof', 'instanceof', 'in', 'of', 'keyof', 'new', 'delete', 'void', 'as', 'satisfies', 'is', 'infer', 'await', 'yield', 'unique', 'asserts']);
const KW_STORAGE = new Set(['var', 'let', 'const', 'function', 'class', 'interface', 'enum', 'namespace', 'module', 'import', 'export', 'from', 'declare', 'abstract', 'public', 'private', 'protected', 'static', 'readonly', 'get', 'set', 'async', 'extends', 'implements', 'type', 'override', 'accessor', 'out', 'using', 'global']);
const KW_TYPE_BUILTIN = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint']);
const KW_CONST_BUILTIN = new Set(['true', 'false', 'null']);
const KW_THIS_SUPER = new Set(['this', 'super']);

const STRUCTURAL_PUNCT = new Set<number>([
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.DotToken, ts.SyntaxKind.DotDotDotToken,
  ts.SyntaxKind.AtToken, ts.SyntaxKind.ColonToken,
]);

function kwRole(text: string, node: ts.Node): RoleName {
  // `void` is dual-use: the `void expr` operator vs the `: void` type.
  if (text === 'void') return node.parent?.kind === ts.SyntaxKind.VoidExpression ? R.kwOperator : R.typeBuiltin;
  if (KW_CONST_BUILTIN.has(text)) return R.constBuiltin;
  if (KW_THIS_SUPER.has(text)) return R.thisSuper;
  if (KW_TYPE_BUILTIN.has(text)) return R.typeBuiltin;
  if (KW_CONTROL.has(text)) return R.kwControl;
  if (KW_OPERATOR.has(text)) return R.kwOperator;
  if (KW_STORAGE.has(text)) return R.kwStorage;
  return R.kwOther;
}

// Classify an identifier by its structural position in the parse tree.
function identRole(node: ts.Node): RoleName {
  const p = node.parent;
  if (!p) return R.valueRef;
  const is = (fn: (n: ts.Node) => boolean) => fn(p);
  const named = (n: any) => n.name === node;

  if (is(ts.isFunctionDeclaration) && named(p)) return R.funcDecl;
  if (is(ts.isFunctionExpression) && named(p)) return R.funcDecl;
  if (is(ts.isMethodDeclaration) && named(p)) return R.funcDecl;
  if (is(ts.isMethodSignature) && named(p)) return R.funcDecl;
  if (is(ts.isGetAccessorDeclaration) && named(p)) return R.funcDecl;
  if (is(ts.isSetAccessorDeclaration) && named(p)) return R.funcDecl;

  if (is(ts.isParameter) && named(p)) return R.parameter;
  if (is(ts.isTypeParameterDeclaration) && named(p)) return R.typeParam;

  if (is(ts.isVariableDeclaration) && named(p)) return R.varDecl;
  if (is(ts.isBindingElement)) {
    if ((p as ts.BindingElement).propertyName === node) return R.propAccess;
    return R.varDecl;
  }

  if (is(ts.isPropertyDeclaration) && named(p)) return R.propDecl;
  if (is(ts.isPropertySignature) && named(p)) return R.propDecl;
  if (is(ts.isPropertyAssignment) && named(p)) return R.propDecl;
  if (is(ts.isShorthandPropertyAssignment)) return R.valueRef;
  if (is(ts.isEnumMember) && named(p)) return R.enumMember;

  if (is(ts.isClassDeclaration) && named(p)) return R.typeDecl;
  if (is(ts.isClassExpression) && named(p)) return R.typeDecl;
  if (is(ts.isInterfaceDeclaration) && named(p)) return R.typeDecl;
  if (is(ts.isTypeAliasDeclaration) && named(p)) return R.typeDecl;
  if (is(ts.isEnumDeclaration) && named(p)) return R.typeDecl;
  if (is(ts.isModuleDeclaration) && named(p)) return R.namespace;

  if (is(ts.isTypeReferenceNode)) return R.typeRef;
  if (is(ts.isTypeQueryNode)) return R.typeRef;
  if (is(ts.isExpressionWithTypeArguments)) return R.typeRef;
  if (is(ts.isQualifiedName)) return R.typeRef;
  if (is(ts.isImportTypeNode)) return R.typeRef;
  if (is(ts.isTypePredicateNode)) return R.typeRef;

  if (is(ts.isPropertyAccessExpression)) {
    const pa = p as ts.PropertyAccessExpression;
    if (pa.name === node) {
      const gp = p.parent;
      if (gp && ts.isCallExpression(gp) && gp.expression === p) return R.methodCall;
      return R.propAccess;
    }
    return R.valueRef; // the object (LHS)
  }
  if (is(ts.isCallExpression) && (p as ts.CallExpression).expression === node) return R.methodCall;
  if (is(ts.isNewExpression) && (p as ts.NewExpression).expression === node) return R.classRef;
  if (is(ts.isDecorator)) return R.classRef;

  if (is(ts.isImportSpecifier) || is(ts.isExportSpecifier)) return R.importBinding;
  if (is(ts.isImportClause) || is(ts.isNamespaceImport) || is(ts.isNamespaceExport)) return R.importBinding;

  if (node.kind === ts.SyntaxKind.Identifier && (node as ts.Identifier).text === 'undefined') return R.constBuiltin;

  return R.valueRef;
}

function leafRole(node: ts.Node, text: string): { role: RoleName; cat: GoldToken['cat'] } {
  const k = node.kind;
  if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) return { role: identRole(node), cat: 'id' };
  if (k === ts.SyntaxKind.StringLiteral) return { role: R.litString, cat: 'lit' };
  if (k === ts.SyntaxKind.NumericLiteral) return { role: R.litNumber, cat: 'lit' };
  if (k === ts.SyntaxKind.BigIntLiteral) return { role: R.litBigint, cat: 'lit' };
  if (k === ts.SyntaxKind.RegularExpressionLiteral) return { role: R.litRegex, cat: 'lit' };
  if (k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail) return { role: R.litTemplate, cat: 'lit' };
  if (k >= ts.SyntaxKind.FirstKeyword && k <= ts.SyntaxKind.LastKeyword) return { role: kwRole(text, node), cat: 'kw' };
  // the ambiguity fork: < > / are operators here iff tsc parsed them into a binary
  // expression (vs a generic bracket / regex). This is the source token of #978/#853.
  if ((k === ts.SyntaxKind.LessThanToken || k === ts.SyntaxKind.GreaterThanToken || k === ts.SyntaxKind.SlashToken) &&
      node.parent?.kind === ts.SyntaxKind.BinaryExpression) {
    return { role: R.opCompare, cat: 'punct' };
  }
  if (k >= ts.SyntaxKind.FirstPunctuation && k <= ts.SyntaxKind.LastPunctuation) {
    return { role: STRUCTURAL_PUNCT.has(k) ? R.punct : R.op, cat: 'punct' };
  }
  return { role: R.punct, cat: 'punct' }; // unknown stray token → lexical floor
}

// ts.SyntaxKind has duplicate values (FirstNode===QualifiedName, …); its reverse
// map returns the alias. Build a canonical name map that prefers the real name.
const KIND_NAME: Record<number, string> = {};
for (const name of Object.keys(ts.SyntaxKind)) {
  const v = (ts.SyntaxKind as any)[name];
  if (typeof v === 'number' && !/^(First|Last)/.test(name) && !(v in KIND_NAME)) KIND_NAME[v] = name;
}
const kindName = (k: number): string => KIND_NAME[k] ?? ts.SyntaxKind[k] ?? String(k);

const isJSDoc = (k: number): boolean => k >= ts.SyntaxKind.FirstJSDocNode && k <= ts.SyntaxKind.LastJSDocNode;

function oracle(text: string): GoldToken[] {
  const sf = ts.createSourceFile('bench.ts', text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const out: GoldToken[] = [];

  const visit = (node: ts.Node): void => {
    if (isJSDoc(node.kind)) return; // doc comments are graded as comment trivia, not as code
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      if (end <= start) return; // skip zero-width (EOF, missing) tokens
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      const tkText = text.slice(start, end);
      const { role, cat } = leafRole(node, tkText);
      const gp = node.parent?.parent;
      out.push({
        start, end, text: tkText, role, cat,
        parentKind: node.parent ? kindName(node.parent.kind) : 'none',
        grandKind: gp ? kindName(gp.kind) : 'none',
      });
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);

  // comments are trivia (not in the AST) — scan them in separately
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ false, ts.LanguageVariant.Standard, text);
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      out.push({ start, end, text: text.slice(start, end), role: R.comment, cat: 'comment', parentKind: 'Comment', grandKind: 'none' });
    }
    tok = scanner.scan();
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

// ── TextMate tokenization → tokens with absolute offsets ──────────────────────
interface TmToken { start: number; end: number; scope: string; }

function tmTokenize(grammar: vsctm.IGrammar, text: string): TmToken[] {
  const lines = text.split('\n');
  const toks: TmToken[] = [];
  let ruleStack = INITIAL;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) {
      toks.push({
        start: offset + t.startIndex,
        end: offset + t.endIndex,
        scope: t.scopes[t.scopes.length - 1],
      });
    }
    ruleStack = r.ruleStack;
    offset += line.length + 1; // + '\n'
  }
  return toks;
}

// scope of the TM token covering offset `pos` (binary search; '' if none)
function scopeAt(toks: TmToken[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans >= 0 && toks[ans].end > pos) return toks[ans].scope;
  return '';
}

// ── cell key (the context-granularity knob) ───────────────────────────────────
function cellKey(t: GoldToken): string {
  if (t.cat !== 'id') return `${t.role}`; // literals/keywords/punct: context doesn't move the scope
  if (GRAN === 'role') return `${t.role}`;
  if (GRAN === 'parent2') return `${t.role}@${t.parentKind}>${t.grandKind}`;
  return `${t.role}@${t.parentKind}`;
}

// ─── debug mode: dump alignment for one snippet, then exit ─────────────────────
if (DEBUG_CODE) {
  const gold = oracle(DEBUG_CODE);
  const tmO = tmTokenize(officialGrammar, DEBUG_CODE);
  const tmM = tmTokenize(monogramGrammar, DEBUG_CODE);
  console.log(`\nDEBUG  «${DEBUG_CODE}»   gran=${GRAN}\n`);
  console.log('token'.padEnd(14) + 'role'.padEnd(16) + 'cell'.padEnd(30) + 'official'.padEnd(26) + 'monogram');
  console.log('─'.repeat(120));
  for (const t of gold) {
    if (t.role === R.punct || t.role === R.op) continue;
    const so = scopeAt(tmO, t.start), sm = scopeAt(tmM, t.start);
    const vo = gradeScope(t.role, so), vm = gradeScope(t.role, sm);
    const mark = (v: Verdict) => (v === 'exact' ? '✓' : v === 'family' ? '≈' : '✗');
    console.log(
      JSON.stringify(t.text).slice(0, 13).padEnd(14) +
      t.role.padEnd(16) + cellKey(t).padEnd(30) +
      `${mark(vo)} ${so || '(none)'}`.padEnd(26) + `${mark(vm)} ${sm || '(none)'}`,
    );
  }
  process.exit(0);
}

// ── shared types + scoring helpers ────────────────────────────────────────────
type G = 'official' | 'monogram';
interface Cell {
  role: RoleName;
  tier: 'strict' | 'lenient';
  key: string;
  occ: number;
  files: Set<number>;
  correct: { official: number; monogram: number };
  exact: { official: number; monogram: number };
  example: { text: string; official: string; monogram: string };
}
interface Miss { n: number; ex: string; role: RoleName }

const cellCorrect = (c: Cell, g: G) => c.correct[g] * 2 >= c.occ; // majority of occurrences
const cellExact = (c: Cell, g: G) => c.exact[g] * 2 >= c.occ;
const count = (list: Cell[], pred: (c: Cell) => boolean) => list.filter(pred).length;
const pct = (n: number, d: number) => (d === 0 ? '  n/a' : ((n / d) * 100).toFixed(1).padStart(5));
const L = '═'.repeat(74);

// ── grade a list of {name,text} inputs, print its report, return per-input pass ─
interface InputResult { name: string; okO: boolean; okM: boolean; graded: number }
interface BenchSummary {
  label: string; nFiles: number;
  snip: { o: number; m: number; n: number };
  strict: { n: number; oRole: number; mRole: number; oExact: number; mExact: number };
  token: { n: number; oRole: number; oExact: number; mRole: number; mExact: number };
}
function runBench(label: string, corpusDesc: string, inputs: { name: string; text: string }[]): { perInput: InputResult[]; summary: BenchSummary } {
  const perInput: InputResult[] = [];
  const cells = new Map<string, Cell>();
  const seenRoles = new Set<string>();
  const misses: Record<G, Map<string, Miss>> = { official: new Map(), monogram: new Map() };
  let nFiles = 0, nSkippedInvalid = 0, nSkippedMulti = 0, nErrored = 0;
  const tokAcc: Record<G, { correct: number; exact: number; total: number }> = {
    official: { correct: 0, exact: 0, total: 0 },
    monogram: { correct: 0, exact: 0, total: 0 },
  };
  // per-snippet pass: did the grammar get EVERY graded token's role right in this
  // input? The right metric for a curated probe set (each snippet = one bug pattern),
  // where cell-majority would let easy uses outvote the one token under test.
  const snipPass: Record<G, number> = { official: 0, monogram: 0 };

  for (let fi = 0; fi < inputs.length; fi++) {
    const text = inputs[fi].text;
    if (/^\s*\/\/\s*@filename:/im.test(text)) { nSkippedMulti++; continue; } // multi-file concat
    const sf = ts.createSourceFile('c.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) { nSkippedInvalid++; continue; } // invalid → not gradable

    let gold: GoldToken[], tmO: TmToken[], tmM: TmToken[];
    try {
      gold = oracle(text);
      tmO = tmTokenize(officialGrammar, text);
      tmM = tmTokenize(monogramGrammar, text);
    } catch { nErrored++; continue; }
    nFiles++;
    const ok: Record<G, boolean> = { official: true, monogram: true };
    let gradedHere = 0;

    for (const t of gold) {
      seenRoles.add(t.role);
      const tier = ROLE_SPEC[t.role].tier;
      if (tier === 'lexical') continue; // lexical floor: excluded from every headline
      gradedHere++;

      const so = scopeAt(tmO, t.start);
      const sm = scopeAt(tmM, t.start);
      const vo = gradeScope(t.role, so);
      const vm = gradeScope(t.role, sm);

      const rec = (g: G, v: Verdict, scope: string) => {
        tokAcc[g].total++;
        if (isCorrect(v)) tokAcc[g].correct++;
        else {
          ok[g] = false;
          const k = `${t.role} → ${normScopeShort(scope)}`;
          const m = misses[g].get(k) ?? { n: 0, ex: t.text, role: t.role };
          m.n++; misses[g].set(k, m);
        }
        if (v === 'exact') tokAcc[g].exact++;
      };
      rec('official', vo, so);
      rec('monogram', vm, sm);

      const key = cellKey(t);
      let c = cells.get(key);
      if (!c) {
        c = { role: t.role, tier, key, occ: 0, files: new Set(), correct: { official: 0, monogram: 0 }, exact: { official: 0, monogram: 0 }, example: { text: t.text, official: so, monogram: sm } };
        cells.set(key, c);
      }
      c.occ++;
      c.files.add(fi);
      if (isCorrect(vo)) c.correct.official++;
      if (isCorrect(vm)) c.correct.monogram++;
      if (vo === 'exact') c.exact.official++;
      if (vm === 'exact') c.exact.monogram++;
    }
    if (ok.official) snipPass.official++;
    if (ok.monogram) snipPass.monogram++;
    perInput.push({ name: inputs[fi].name, okO: ok.official, okM: ok.monogram, graded: gradedHere });
  }

  const cellList = [...cells.values()];
  const strictCells = cellList.filter((c) => c.tier === 'strict');
  const lenientCells = cellList.filter((c) => c.tier === 'lenient');
  const Sn = strictCells.length, Ln = lenientCells.length;

  console.log('\n' + L);
  console.log(`  Highlight Correctness Bench — ${label}`);
  console.log(L);
  console.log(`  corpus     ${corpusDesc}  ·  granularity = ${GRAN}`);
  console.log(`  inputs     ${nFiles} graded · ${nSkippedInvalid} invalid-skipped · ${nSkippedMulti} multifile-skipped · ${nErrored} errored`);
  console.log(`  cells      ${Sn} strict (graded) · ${Ln} lenient (contested) · ${cellList.length} total · ${tokAcc.official.total} tokens`);
  console.log(L);
  console.log('  Per-SNIPPET — input fully role-correct (every probe right; best for curated sets)');
  for (const g of ['official', 'monogram'] as const) {
    console.log(`    ${g.padEnd(14)}    ${pct(snipPass[g], nFiles)}%  (${snipPass[g]}/${nFiles})`);
  }
  console.log('');
  console.log('  Per-CELL — strict cells (one defensible answer each), frequency-neutral');
  console.log('                       role-correct          exact-scope');
  for (const g of ['official', 'monogram'] as const) {
    const cc = count(strictCells, (c) => cellCorrect(c, g));
    const ce = count(strictCells, (c) => cellExact(c, g));
    console.log(`    ${g.padEnd(14)}    ${pct(cc, Sn)}%  (${cc}/${Sn})        ${pct(ce, Sn)}%  (${ce}/${Sn})`);
  }
  console.log('');
  console.log('  Lenient cells (contested role; a fail = painted as the WRONG kind entirely)');
  for (const g of ['official', 'monogram'] as const) {
    const cc = count(lenientCells, (c) => cellCorrect(c, g));
    console.log(`    ${g.padEnd(14)}    ${pct(cc, Ln)}%  (${cc}/${Ln})`);
  }
  console.log('');
  console.log('  Secondary — every graded token (frequency-weighted, real-world feel)');
  for (const g of ['official', 'monogram'] as const) {
    const ta = tokAcc[g];
    console.log(`    ${g.padEnd(14)}    role ${pct(ta.correct, ta.total)}%   exact ${pct(ta.exact, ta.total)}%`);
  }
  console.log(L);

  // per-role cell coverage (tier-marked)
  const roleNames = [...new Set(cellList.map((c) => c.role))].sort();
  console.log('\n── per-role CELL coverage (role-correct) ──');
  console.log('  role'.padEnd(22) + 'tier'.padEnd(9) + 'cells'.padStart(6) + 'official'.padStart(11) + 'monogram'.padStart(11));
  for (const role of roleNames) {
    const rc = cellList.filter((c) => c.role === role);
    const o = count(rc, (c) => cellCorrect(c, 'official'));
    const m = count(rc, (c) => cellCorrect(c, 'monogram'));
    console.log(`  ${role.padEnd(20)}${ROLE_SPEC[role].tier.padEnd(9)}${String(rc.length).padStart(6)}${`${o}/${rc.length}`.padStart(11)}${`${m}/${rc.length}`.padStart(11)}`);
  }

  // disagreements (strict + lenient): the deltas that matter
  const disagree = cellList
    .filter((c) => cellCorrect(c, 'official') !== cellCorrect(c, 'monogram'))
    .sort((a, b) => b.occ - a.occ);
  console.log(`\n── cells where the grammars DISAGREE (${disagree.length}) ──`);
  for (const c of disagree.slice(0, 22)) {
    const winner = cellCorrect(c, 'monogram') ? '+monogram' : '+official';
    console.log(`  ${winner} ${c.key}`.padEnd(50) + `occ=${c.occ}`.padStart(8) +
      `  «${c.example.text}» off=${normScopeShort(c.example.official)} mono=${normScopeShort(c.example.monogram)}`);
  }

  // SELF-AUDIT: where each grammar loses — read these before trusting the %.
  for (const g of ['official', 'monogram'] as const) {
    const top = [...misses[g].entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    const totalMiss = [...misses[g].values()].reduce((s, m) => s + m.n, 0);
    console.log(`\n── ${g} role-level MISSES (${totalMiss} tokens, top ${top.length}) ──`);
    for (const [k, m] of top) console.log(`  ${String(m.n).padStart(5)}×  ${k.padEnd(46)} e.g. «${m.ex}»`);
  }

  // blind spots: roles never exercised by this corpus
  const allRoles = Object.keys(ROLE_SPEC).filter((r) => ROLE_SPEC[r as RoleName].tier !== 'lexical');
  const unseen = allRoles.filter((r) => !seenRoles.has(r));
  console.log('\n── blind spots (roles with 0 graded tokens here) ──');
  console.log(unseen.length ? '  ' + unseen.join(', ') : '  none — every role exercised');
  console.log(L + '\n');

  const summary: BenchSummary = {
    label, nFiles,
    snip: { o: snipPass.official, m: snipPass.monogram, n: nFiles },
    strict: {
      n: Sn,
      oRole: count(strictCells, (c) => cellCorrect(c, 'official')),
      mRole: count(strictCells, (c) => cellCorrect(c, 'monogram')),
      oExact: count(strictCells, (c) => cellExact(c, 'official')),
      mExact: count(strictCells, (c) => cellExact(c, 'monogram')),
    },
    token: {
      n: tokAcc.official.total,
      oRole: tokAcc.official.correct, oExact: tokAcc.official.exact,
      mRole: tokAcc.monogram.correct, mExact: tokAcc.monogram.exact,
    },
  };
  return { perInput, summary };
}

// ── aggregate per-input results by documented ISSUE (the denominator the bug
// ledger defines): an issue "handled" iff every one of its cases is role-correct.
interface IssueStats { total: number; adj: number; offPass: number; monoPass: number; fixes: string[]; regress: string[]; bothFail: string[] }
function reportByIssue(perInput: InputResult[]): IssueStats {
  const issueOf = (name: string): string | null => (name.match(/#(\d+)/)?.[1] ?? null);
  const byIssue = new Map<string, { okO: boolean; okM: boolean; graded: number; ex: string }>();
  for (const r of perInput) {
    const k = issueOf(r.name);
    if (!k) continue;
    const e = byIssue.get(k) ?? { okO: true, okM: true, graded: 0, ex: r.name };
    e.okO = e.okO && r.okO;
    e.okM = e.okM && r.okM;
    e.graded += r.graded;
    byIssue.set(k, e);
  }
  const all = [...byIssue.entries()];
  // only issues the neutral oracle can actually adjudicate (have role-graded tokens)
  const adj = all.filter(([, e]) => e.graded > 0);
  const D = adj.length;
  const offPass = adj.filter(([, e]) => e.okO).length;
  const monoPass = adj.filter(([, e]) => e.okM).length;
  const byNum = (a: string, b: string) => +a - +b;
  const fixes = adj.filter(([, e]) => !e.okO && e.okM).map(([k]) => k).sort(byNum);
  const regress = adj.filter(([, e]) => e.okO && !e.okM).map(([k]) => k).sort(byNum);
  const bothFail = adj.filter(([, e]) => !e.okO && !e.okM).map(([k]) => k).sort(byNum);

  console.log('\n' + L);
  console.log('  PER-ISSUE — documented bugs as the denominator (neutral tsc oracle)');
  console.log(L);
  console.log(`  ${all.length} documented issues · ${D} oracle-adjudicable (rest hinge on exact-scope`);
  console.log(`  or lexical tokens the syntactic oracle does not judge)`);
  console.log(`    official handles    ${pct(offPass, D)}%  (${offPass}/${D})`);
  console.log(`    monogram handles    ${pct(monoPass, D)}%  (${monoPass}/${D})`);
  console.log('');
  console.log(`  Verified Monogram fixes — official WRONG, Monogram right (${fixes.length}):`);
  console.log(`    ${fixes.length ? '#' + fixes.join(' #') : '(none)'}`);
  console.log(`  Monogram worse than official (${regress.length}): ${regress.length ? '#' + regress.join(' #') : '(none)'}`);
  console.log(`  Both wrong (${bothFail.length}): ${bothFail.length ? '#' + bothFail.join(' #') : '(none)'}`);
  console.log(L + '\n');
  return { total: all.length, adj: D, offPass, monoPass, fixes, regress, bothFail };
}

// ── README auto-generation: one compact bar chart, one row per language ────────
// Deliberately NOT expanded (no per-issue tables): this scales to many languages.
interface LangResult { name: string; issue: IssueStats | null; note?: string }

const BAR_W = 22;
function bar(frac: number): string {
  const f = Math.max(0, Math.min(BAR_W, Math.round(frac * BAR_W)));
  return '█'.repeat(f) + '░'.repeat(BAR_W - f);
}

function buildBenchMarkdown(langs: LangResult[]): string {
  const out: string[] = [];
  out.push('<!-- generated by `npm run bench:readme` — do not edit by hand -->');
  out.push('');
  out.push("Each bar = **% of that language's documented official-grammar bugs** the highlighter renders");
  out.push('correctly, graded against a neutral `tsc` oracle (100% = all of them). Monogram derives its');
  out.push('highlighter from its conformance-proven parser; the official one is hand-written regex.');
  out.push('');
  out.push('```');
  for (const L of langs) {
    out.push(L.name);
    if (L.issue && L.issue.adj > 0) {
      const m = L.issue.monoPass / L.issue.adj;
      const o = L.issue.offPass / L.issue.adj;
      out.push(`  Monogram  ${bar(m)}  ${Math.round(m * 100)}%  (${L.issue.monoPass}/${L.issue.adj})`);
      out.push(`  official  ${bar(o)}  ${Math.round(o * 100)}%  (${L.issue.offPass}/${L.issue.adj})`);
    } else {
      out.push(`  ${L.note ?? 'pending — not yet on the neutral-oracle bench'}`);
    }
  }
  out.push('```');
  out.push('');
  const ts = langs.find((l) => l.issue && l.issue.adj > 0);
  const ctx = ts
    ? `TypeScript = ${ts.issue!.adj} oracle-adjudicable open [\`microsoft/TypeScript-TmLanguage\`](https://github.com/microsoft/TypeScript-TmLanguage/issues) issues ([\`test/issue-cases.ts\`](test/issue-cases.ts)) — ${ts.issue!.fixes.length} of Monogram's wins are fixes the official grammar gets *structurally* wrong. `
    : '';
  out.push(`<sub>${ctx}Per-issue breakdown: \`node test/highlight-bench.ts\`. Regenerate: \`npm run bench:readme\`.</sub>`);
  return out.join('\n');
}

function writeReadmeBlock(markdown: string): void {
  const path = 'README.md';
  const START = '<!-- bench:start -->';
  const END = '<!-- bench:end -->';
  let readme: string;
  try { readme = readFileSync(path, 'utf-8'); } catch { console.error(`cannot read ${path}`); return; }
  const block = `${START}\n${markdown}\n${END}`;
  const s = readme.indexOf(START), e = readme.indexOf(END);
  let next: string;
  if (s >= 0 && e > s) {
    next = readme.slice(0, s) + block + readme.slice(e + END.length);
  } else {
    console.error(`markers not found in README.md — add a "${START} … ${END}" block where you want the comparison.`);
    return;
  }
  if (next !== readme) {
    writeFileSync(path, next);
    console.log(`✓ README.md bench block updated (${markdown.split('\n').length} lines)`);
  } else {
    console.log('README.md bench block already current.');
  }
}

// ── corpus loaders ────────────────────────────────────────────────────────────
async function allTs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await allTs(full)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

// ── run selected corpora ──────────────────────────────────────────────────────
const WRITE_README = argv.includes('--write-readme');
const WHICH = getFlag('--corpus') ?? 'both'; // --write-readme respects --corpus (CI uses adversarial = deterministic, no TS clone)

let issueStats: IssueStats | null = null;

if (WHICH === 'parser' || WHICH === 'both') {
  if (!existsSync(PARSER_DIR)) {
    const msg = `Parser corpus not found at ${PARSER_DIR}\n  git clone https://github.com/microsoft/TypeScript /tmp/ts-repo`;
    if (WRITE_README) console.error(`(skipping parser corpus — ${msg.split('\n')[0]})`);
    else { console.error(msg); process.exit(1); }
  } else {
    let files = (await allTs(PARSER_DIR)).sort();
    if (Number.isFinite(LIMIT)) files = files.slice(0, LIMIT);
    const inputs: { name: string; text: string }[] = [];
    for (const f of files) {
      try { inputs.push({ name: f, text: readFileSync(f, 'utf-8') }); } catch { /* skip unreadable */ }
    }
    runBench('parser conformance corpus', 'tests/cases/conformance/parser (TS parser test suite)', inputs);
  }
}

if (WHICH === 'adversarial' || WHICH === 'both') {
  // The adversarial corpus IS the documented bug ledger: every case from
  // test/issue-cases.ts (the microsoft/TypeScript-TmLanguage issues Monogram claims
  // to fix), graded by the NEUTRAL tsc oracle, then aggregated per documented issue.
  const advInputs = [
    ...issueTests.map((t) => ({ name: t.label, text: t.input })),
    ...issueMultiLine.map((t) => ({ name: t.label, text: t.lines.join('\n') })),
  ];
  const distinct = new Set(advInputs.map((i) => i.name.match(/#(\d+)/)?.[1]).filter(Boolean)).size;
  const res = runBench(
    'adversarial — documented official-grammar bug ledger',
    `${distinct} issues / ${advInputs.length} cases from test/issue-cases.ts`,
    advInputs,
  );
  issueStats = reportByIssue(res.perInput);
}

if (WRITE_README) {
  // One row per language. TypeScript has the full oracle bench today; add more
  // languages here as each gets its grammar + documented-bug ledger.
  writeReadmeBlock(buildBenchMarkdown([
    { name: 'TypeScript', issue: issueStats },
    { name: 'JavaScript', issue: null, note: 'pending — JS not yet on the neutral-oracle bench (see ROADMAP)' },
  ]));
}
