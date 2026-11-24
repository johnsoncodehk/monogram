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

const ROOT = join(import.meta.dirname, '..');
const RECORD = join(ROOT, 'test/tm-monarch-agreement.json');
const TEST262 = '/tmp/test262';

// Who is right, per class, judged by the grammar (the role the parsed construct has there), not by
// which highlighter is older. 'monarch' / 'textmate': that one is wrong; 'convention': no grammar
// truth (an editor convention or a heuristic kept on purpose); 'open': not attributed yet.
const DISPOSITION: Record<string, [string, string]> = {
  'type -> name': ['monarch', 'Monarch has no type context after `:` / in interface bodies, nor a declaration name (`class C`): the shared context IR\'s first customer'],
  'name -> keyword  (after `.`)': ['monarch', 'a name after a member-access text is a property, never a keyword (`e.type`, `m.get`)'],
  'text -> punct': ['textmate', 'TextMate gives a bracket in a type position no scope at all'],
  'name -> type': ['open', ''],
  'name -> keyword': ['monarch', 'a contextual keyword used as a name where its follower set does not tell (`set,` after a word, `of` before a word)'],
  'keyword -> name': ['open', ''],
  'type -> keyword': ['monarch', 'the parser reads `const` in `as const` as a type name (Type -> Ident); Monarch has no type context after `as`'],
  'keyword -> punct': ['monarch', '`void` in a type position is a type name to the parser (TextMate: the primitive keyword); Monarch has no type context'],
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
  const out: Record<string, { files: number; chars: number; agree: number; classes: Record<string, number> }> = {};
  for (const [lang, files, what] of [['typescript', ts, `the pinned in-repo sources (${REPO_CORPUS_AT.slice(0, 7)})`], ['javascript', js, `every 20th test262 test/language file`]] as const) {
    const t0 = performance.now();
    const r = await compare(lang, files);
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
  }
  if (write) { writeFileSync(RECORD, JSON.stringify(out, null, 1) + '\n'); console.log(`wrote ${RECORD}`); return 0; }
  if (fell) console.log(`fell: ${fell} class(es) below the record: re-record when convenient: node test/monarch-dialect.ts --agreement --write`);
  if (bad) console.error(`✗ ${bad} class(es) rose or appeared, or an agreement fell; if intended: node test/monarch-dialect.ts --agreement --write`);
  return bad ? 1 : 0;
}

async function compare(lang: string, files: { name: string; code: string }[]) {
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
    for (let i = 0; i < src.length; i++) {
      if (/\s/.test(src[i])) continue;
      chars++;
      if (tmAt[i] === monAt[i]) { agree++; continue; }
      let k = `${tmAt[i]} -> ${monAt[i]}`;
      if (monAt[i] === 'keyword') {
        let p = i; while (p > 0 && /\w/.test(src[p - 1])) p--; while (p > 0 && /[ \t]/.test(src[p - 1])) p--;
        if (src[p - 1] === '.') k += '  (after `.`)';
      }
      if (last !== k || lastAt !== i - 1) classes[k] = (classes[k] ?? 0) + 1;
      last = k; lastAt = i;
    }
  }
  return { files: files.length, chars, agree: Math.round(1e4 * agree / chars) / 100, classes };
}
