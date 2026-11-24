// tm-monarch-agreement.ts: `node test/monarch-dialect.ts --agreement [--write]`. The committed
// TextMate and Monarch grammars of javascript and typescript tokenize the same real code, and
// every place they disagree is counted by CLASS against a record (test/tm-monarch-agreement.json).
//
// No other check compares the two highlighters: each dialect gate grades one of them on chosen
// rows. The failure this catches: a generator change that makes them disagree MORE on real code: a
// class rises above the record, a new class appears, or a corpus's agreement falls. A class that
// falls passes with one line (re-record when convenient): an improvement never stops a landing;
// the landing that makes one on purpose re-records, so the record stays its evidence. Every class
// is compared the same way, small ones included: a fall is never a failure.
//
// Each non-space character gets a ROLE from each highlighter, in Monarch's token families
// (src/highlight-roles.ts's scopeToMonarch for TextMate's scopes): TextMate's innermost scope that
// is not `meta.*` / `source.*`, except that a comment / regexp / string anywhere in the stack
// wins (unless a template expression opened inside the string); Monarch's token as
// test/monarch-tokenize.ts runs it. Roles: name (identifier, variable), punct (operator,
// delimiter*), keyword, type, string, comment, regexp, number, invalid (Monarch's default token),
// text (no role). A class is `<TextMate role> -> <Monarch role>`, a keyword split by whether the
// word follows a member-access `.`. One OCCURRENCE is a run of adjacent characters in one class.
//
// Corpora: TypeScript, the pinned in-repo sources (test/emit-corpus.ts, REPO_CORPUS_AT);
// JavaScript, every 20th file of test262's test/language at its pin (/tmp/test262, as CI clones it).
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { scopeToMonarch } from '../src/highlight-roles.ts';
import type { MonarchLanguage } from '../src/gen-monarch.ts';
import { tokenize } from './monarch-tokenize.ts';
import { inRepoCorpus, REPO_CORPUS_AT } from './emit-corpus.ts';
import { createParser } from '../src/interpreter.ts';
import type { Grammar } from '../src/types.ts';
type CstNode = { offset: number; end: number; tokenType?: string; rule?: string; children?: CstNode[] };

const ROOT = join(import.meta.dirname, '..');
const RECORD = join(ROOT, 'test/tm-monarch-agreement.json');
const TEST262 = '/tmp/test262';

// Who is right, per class, judged by the grammar (the role the parsed construct has there), not by
// which highlighter is older. 'monarch' / 'textmate': that one is wrong; 'convention': no grammar
// truth (an editor convention or a heuristic kept on purpose); 'open': not attributed yet.
const DISPOSITION: Record<string, [string, string]> = {
  'type -> name': ['monarch', 'Monarch reads a type position only where one rule\'s text shows it (typeContexts: `as`, `satisfies`, `is`, `type A =`, `let x:`, type arguments): not yet a parameter\'s or a return type\'s `:`, interface / class members, nor a declaration name (`class C`)'],
  'name -> keyword  (after `.`)': ['monarch', 'a name after a member-access text is a property, never a keyword (`e.type`, `m.get`)'],
  'text -> punct': ['textmate', 'TextMate gives a bracket in a type position no scope at all'],
  'name -> type': ['open', ''],
  'name -> type  (the parser: a type)': ['textmate', 'the interpreter reads a `@type` rule there and TextMate a variable: a type argument `T[]` after a name (`new Map<string, RuleExpr[]>()`, `Array<Step[]>(n)`: the generic-call lookahead\'s character class has no `[` `]`), and a member line after a member named `type` in a multi-line type alias (`  type: string;` then `  fields: FieldDecl[];`)'],
  'name -> keyword': ['open', 'mixed: Monarch, a contextual keyword used as a name before a word (`import defer as ns`); TextMate, a keyword it reads as a name (`super()`, `static \\u{6F}()`, `new function`)'],
  'keyword -> name': ['open', ''],
  'type -> keyword': ['monarch', 'the parser reads `const` in `as const` as a type name (Type -> Ident)'],
  'keyword -> punct': ['convention', 'TextMate: `void` in a type position is its primitive keyword (the parser reads a type name; Monarch has no type context) and the `*` of `import * as` is constant.language (the official grammar\'s convention)'],
  'name -> punct': ['monarch', 'an operator word as a property name (`s.is`, `x.delete`)'],
  'text -> name': ['convention', 'a Unicode 15 identifier character: vscode-oniguruma\'s Unicode tables are older than V8\'s (both read \\p{ID_Start})'],
  'text -> invalid': ['monarch', 'a non-ASCII identifier character Monarch does not read'],
  'comment -> regexp': ['convention', 'U+2028 / U+2029 end a line for the parser; TextMate is fed `\\n` lines'],
  'comment -> name': ['convention', 'as above (and a `#!` line)'],
};

export async function agreement(): Promise<number> {
  const write = process.argv.includes('--write');
  const require = createRequire(import.meta.url);
  const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  if (!existsSync(join(TEST262, 'test/language'))) {
    console.error(`✗ NOT RUN: the pinned test262 corpus is absent at ${TEST262} (see test/test262.ts).`);
    return 1;
  }
  const js: { name: string; code: string }[] = [];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []);
  walk(join(TEST262, 'test/language')).sort().forEach((f, i) => { if ((i + 1) % 20 === 0) js.push({ name: f, code: readFileSync(f, 'utf8') }); });
  const ts = inRepoCorpus().filter(f => !f.name.includes('#'));
  const out: Record<string, { files: number; chars: number; agree: number; classes: Record<string, number>; refusals: Record<string, string[]> }> = {};
  for (const [lang, files, what] of [['typescript', ts, `the pinned in-repo sources (${REPO_CORPUS_AT.slice(0, 7)})`], ['javascript', js, `every 20th test262 test/language file`]] as const) {
    const t0 = performance.now();
    const r = { ...await compare(lang, files), refusals: await refusalsOf(lang) };
    out[lang] = r;
    console.log(`${lang}: ${what}: ${files.length} files, ${r.chars} characters, agree ${r.agree.toFixed(2)}% (${Math.round(performance.now() - t0)} ms)`);
  }
  const old = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {};
  let bad = 0, fell = 0;
  for (const lang of Object.keys(out)) {
    const now = out[lang].classes, was: Record<string, number> = old[lang]?.classes ?? {};
    const wasAgree: number | undefined = old[lang]?.agree;
    if (wasAgree !== undefined && out[lang].agree < wasAgree) { bad++; console.log(`  ✗ AGREEMENT FELL    ${lang}: ${out[lang].agree}% (record ${wasAgree}%)`); }
    // what fails first (a class that rose or appeared), then by size
    const rank = (k: string) => (now[k] ?? 0) > (was[k] ?? 0) ? 0 : 1;
    for (const k of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort((a, b) => rank(a) - rank(b) || (now[b] ?? 0) - (now[a] ?? 0))) {
      const n = now[k] ?? 0, w = was[k] ?? 0;
      const [who, why] = DISPOSITION[k] ?? ['open', ''];
      const mark = n > w ? (k in was ? '✗ ROSE' : '✗ NEW') : n < w ? 'fell' : ' ';
      if (n > w) bad++;
      else if (n < w) fell++;
      console.log(`  ${mark.padEnd(19)} ${String(n).padStart(6)} (record ${String(w).padStart(6)})  ${k.padEnd(30)} wrong: ${who.padEnd(10)} ${why}`);
    }
    // the constructs a highlighter declines (src/define-highlighter.ts): recorded like a class
    for (const [hl, now] of Object.entries(out[lang].refusals)) {
      const was: string[] = old[lang]?.refusals?.[hl] ?? [];
      // one-sided, as the classes: a new refusal fails, a refusal that went away passes
      const added = now.filter(r => !was.includes(r)), gone = was.filter(r => !now.includes(r));
      if (added.length) bad++;
      if (gone.length) fell++;
      console.log(`  ${(added.length ? '✗ NEW REFUSAL' : gone.length ? 'fell' : ' ').padEnd(19)} ${hl} refuses ${now.length ? now.join('; ') : 'nothing'}`);
    }
  }
  if (write) { writeFileSync(RECORD, JSON.stringify(out, null, 1) + '\n'); console.log(`wrote ${RECORD}`); return 0; }
  if (fell) console.log(`fell: ${fell} class(es) below the record: re-record when convenient: node test/monarch-dialect.ts --agreement --write`);
  if (bad) console.error(`✗ ${bad} class(es) rose or appeared, or an agreement fell; if intended: node test/monarch-dialect.ts --agreement --write`);
  return bad ? 1 : 0;
}

// Each registered highlighter's refusals for the grammar (`<construct>: <reason>`).
async function refusalsOf(lang: string): Promise<Record<string, string[]>> {
  const { registeredHighlighters, highlighterInput } = await import('../src/define-highlighter.ts');
  await import('../src/highlighters.ts');
  const grammar = (await import(join(ROOT, `${lang}.ts`))).default;
  const input = highlighterInput(grammar, lang);
  return Object.fromEntries(registeredHighlighters().map(h => [h.name, h.refusals(input).map(r => `${r.construct}: ${r.reason}`)]));
}

// Per character of `src`: whether the interpreter (src/interpreter.ts) reads it as a token whose
// node is a `@type` rule's (a type name, not a member name inside a type); null when the file
// does not parse.
const parserOf = new Map<string, { parse(src: string): unknown }>();
const grammarOf = new Map<string, Grammar>();
function parsedTypes(lang: string, src: string): boolean[] | null {
  const g = grammarOf.get(lang)!;
  const types = new Set(g.rules.filter(r => r.flags.includes('type')).map(r => r.name));
  let p = parserOf.get(lang);
  if (!p) parserOf.set(lang, p = createParser(g));
  let cst: CstNode;
  try { cst = p.parse(src) as CstNode; } catch { return null; }
  const at = new Array<boolean>(src.length).fill(false);
  const walk = (n: CstNode, typeNode: boolean): void => {
    if (n.tokenType !== undefined) { if (typeNode) for (let i = n.offset; i < n.end; i++) at[i] = true; return; }
    for (const c of n.children ?? []) walk(c, types.has(n.rule ?? ''));
  };
  walk(cst, false);
  return at;
}

async function compare(lang: string, files: { name: string; code: string }[]) {
  grammarOf.set(lang, (await import(join(ROOT, `${lang}.ts`))).default);
  const tm = JSON.parse(readFileSync(join(ROOT, `${lang}.tmLanguage.json`), 'utf8'));
  const mon: MonarchLanguage = JSON.parse(readFileSync(join(ROOT, `${lang}.monarch.json`), 'utf8'));
  const reg = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
    loadGrammar: async (sc: string) => sc === tm.scopeName ? vsctm.parseRawGrammar(JSON.stringify(tm), 'g.json') : null,
  });
  const grammar = (await reg.loadGrammar(tm.scopeName))!;
  const postfix = new RegExp(`\\${(mon as { tokenPostfix?: string }).tokenPostfix ?? '.none'}$`);
  const family = (t: string): string => {
    t = t.replace(postfix, '');
    if (t === '' || t === 'source') return 'text';
    if (t.startsWith('delimiter') || t === 'operator') return 'punct';
    if (t === 'variable' || t === 'identifier') return 'name';
    return t.split('.')[0];
  };
  const langSuffix = /\.(ts|tsx|js|jsx|typescript|javascript)$/;
  const tmRole = (scopes: string[]): string => {
    const s = scopes.slice(1);
    if (s.some(x => x.startsWith('comment'))) return 'comment';
    if (s.some(x => x.startsWith('string.regexp'))) return 'regexp';
    const lastStr = s.map(x => x.startsWith('string')).lastIndexOf(true);
    const lastExpr = s.map(x => x.startsWith('meta.template.expression') || x.startsWith('meta.embedded')).lastIndexOf(true);
    if (lastStr >= 0 && lastStr > lastExpr) return 'string';
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].startsWith('meta.') || s[i].startsWith('source.')) continue;
      return family(scopeToMonarch(s[i].replace(langSuffix, '')));
    }
    return 'text';
  };
  const classes: Record<string, number> = {};
  let chars = 0, agree = 0;
  for (const { code: src } of files) {
    const tmAt = new Array<string>(src.length).fill('text'), monAt = new Array<string>(src.length).fill('text');
    let st = vsctm.INITIAL, base = 0;
    for (const line of src.split('\n')) {
      const r = grammar.tokenizeLine(line, st); st = r.ruleStack;
      for (const t of r.tokens) { const role = tmRole(t.scopes); for (let i = t.startIndex; i < t.endIndex; i++) tmAt[base + i] = role; }
      base += line.length + 1;
    }
    for (const t of tokenize(mon, src)) { const role = family(t.token); for (let i = 0; i < t.text.length; i++) monAt[t.start + i] = role; }
    let last = '', lastAt = -2;
    let inType: boolean[] | null | undefined;
    for (let i = 0; i < src.length; i++) {
      if (/\s/.test(src[i])) continue;
      chars++;
      if (tmAt[i] === monAt[i]) { agree++; continue; }
      let k = `${tmAt[i]} -> ${monAt[i]}`;
      if (monAt[i] === 'keyword') {
        let p = i; while (p > 0 && /\w/.test(src[p - 1])) p--; while (p > 0 && /[ \t]/.test(src[p - 1])) p--;
        if (src[p - 1] === '.') k += '  (after `.`)';
      }
      // a name TextMate paints and Monarch types: which one the parser agrees with is the
      // interpreter's reading (the token inside a `@type` rule's node)
      if (k === 'name -> type' && (inType ??= parsedTypes(lang, src))?.[i]) k += '  (the parser: a type)';
      if (last !== k || lastAt !== i - 1) classes[k] = (classes[k] ?? 0) + 1;
      last = k; lastAt = i;
    }
  }
  return { files: files.length, chars, agree: Math.round(1e4 * agree / chars) / 100, classes };
}
