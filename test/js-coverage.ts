// JavaScript highlighter visual-accuracy gate, mirroring test/coverage.ts.
//
// It scores the GENERATED examples/javascript.tmLanguage.json against VS Code's
// OFFICIAL JavaScript grammar (the sibling of the TS one used by coverage.ts):
//   /Applications/Visual Studio Code.app/.../extensions/javascript/syntaxes/JavaScript.tmLanguage.json
//
// The official grammar declares scopeName "source.js"; the generated one
// declares "source.javascript" (gen-tm derives source.<langName>), exactly
// analogous to the TS case (source.ts vs source.typescript). Each is loaded in
// its own Registry under its own scope.
//
// We tokenize a representative JS sample with both grammars, align tokens by
// text, and bucket each scope difference into exact / category / visual-equiv
// (different scope, same theme color) / real-gap. The headline number is the
// "visual accuracy" %. The JS grammar is fresh + minimal, so this is expected
// to sit below TS's 99.3%; the point is a repeatable gate + baseline.
//
// Self-contained: `node test/js-coverage.ts`.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
const { INITIAL, Registry, parseRawGrammar } = vsctm;
import onig from 'vscode-oniguruma';
const { loadWASM, OnigScanner, OnigString } = onig;

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
const wasmBin = readFileSync(wasmPath);
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const officialPath = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/javascript/syntaxes/JavaScript.tmLanguage.json';
const dslPath = 'examples/javascript.tmLanguage.json';

const officialContent = readFileSync(officialPath, 'utf-8');
const dslContent = readFileSync(dslPath, 'utf-8');

// Official = source.js; generated = source.javascript. Separate registries.
const officialRegistry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.js') return parseRawGrammar(officialContent, 'JavaScript.tmLanguage.json');
    return null;
  },
});

const dslRegistry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.javascript') return parseRawGrammar(dslContent, 'javascript.tmLanguage.json');
    return null;
  },
});

const officialGrammar = await officialRegistry.loadGrammar('source.js');
const dslGrammar = await dslRegistry.loadGrammar('source.javascript');
if (!officialGrammar || !dslGrammar) throw new Error('Failed to load grammars');

// Representative JavaScript: functions, classes, operators, destructuring,
// template literals, regex, and modules. (No TypeScript-only syntax.)
const testCode = `
import defaultExport, { readFileSync as read, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const MAX_RETRIES = 3;
let counter = 0;
var legacy = null;

const settings = {
  verbose: true,
  retries: MAX_RETRIES,
  handler() { return this.retries; },
  get label() { return \`r=\${this.retries}\`; },
  set label(v) { this.retries = v; },
  ['computed']: 42,
  ...defaults,
};

const { verbose = false, prefix, ...rest } = settings;
const [first, , third, ...others] = [1, 2, 3, 4, 5];

class EventEmitter extends EventTarget {
  #listeners = new Map();
  static maxListeners = 10;

  constructor(name) {
    super();
    this.name = name;
    this.#listeners = new Map();
  }

  async *emit(event, ...args) {
    const handlers = this.#listeners.get(event) ?? new Set();
    for (const handler of handlers) {
      yield await handler(...args);
    }
  }

  get count() {
    return [...this.#listeners.values()].reduce((sum, s) => sum + s.size, 0);
  }

  static create(name) {
    return new EventEmitter(name);
  }
}

function createLogger(config) {
  const level = config.verbose ? 0 : 1;
  return {
    log: (message, lvl = level) => {
      if (lvl >= level) {
        console.log(\`\${prefix}: \${message}\`);
      }
    },
    format: (data) => JSON.stringify(data, null, 2),
  };
}

async function* fetchPages(url, transform) {
  let page = 1;
  while (true) {
    const response = await fetch(\`\${url}?page=\${page}\`);
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    const data = await response.json();
    if (data.length === 0) break;
    yield data.map(transform);
    page++;
  }
}

const doubled = [1, 2, 3].map(x => x * 2).filter(x => x > 0);
const chained = obj?.a?.b?.() ?? fallback;
const power = a ** b ** c;
const compare = a < b && b <= c || d === e;
x ??= y; x ||= z; x &&= w;

const re = /^https?:\\/\\/[\\w.-]+\\.[a-z]{2,}\$/gi;
const hex = 0xFF_FF;
const big = 100_000n;
const inst = value instanceof EventEmitter;
const has = "key" in settings;

label: for (let i = 0; i < 10; i++) {
  if (i === 5) continue label;
  if (i > 8) break label;
}

switch (counter) {
  case 0:
    createLogger({ verbose: true });
    break;
  default:
    delete settings.prefix;
}

try {
  const result = await fetchPages('/api', raw => String(raw));
  for await (const chunk of result) {
    console.log(chunk);
  }
} catch (error) {
  console.error(error.message);
} finally {
  console.log('done');
}

export { EventEmitter, createLogger };
export default createLogger;
export * as helpers from './helpers.js';
`.trim();

const lines = testCode.split('\n');

interface TokenInfo {
  text: string;
  line: number;
  scopes: string[];
  innerScope: string;
}

function tokenize(grammar: vsctm.IGrammar, lines: string[]): TokenInfo[] {
  const result: TokenInfo[] = [];
  let ruleStack = INITIAL;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const token of r.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text.trim() === '') continue;
      result.push({
        text: text.trim(),
        line: i + 1,
        scopes: token.scopes,
        innerScope: token.scopes[token.scopes.length - 1],
      });
    }
    ruleStack = r.ruleStack;
  }
  return result;
}

const officialTokens = tokenize(officialGrammar, lines);
const dslTokens = tokenize(dslGrammar, lines);

function normScope(scope: string): string {
  return scope
    .replace(/\.js$/, '')
    .replace(/\.jsx$/, '')
    .replace(/\.ts$/, '')
    .replace(/\.javascript$/, '')
    .replace(/source\.\w+/, 'source');
}

function scopeCategory(scope: string): string {
  const s = normScope(scope);
  if (s.startsWith('comment')) return 'comment';
  if (s.startsWith('string')) return 'string';
  if (s.startsWith('constant.numeric')) return 'constant.numeric';
  if (s.startsWith('constant.character')) return 'constant.character';
  if (s.startsWith('constant.language')) return 'constant.language';
  if (s.startsWith('keyword.control')) return 'keyword.control';
  if (s.startsWith('keyword.operator')) return 'keyword.operator';
  if (s.startsWith('storage.type')) return 'storage.type';
  if (s.startsWith('storage.modifier')) return 'storage.modifier';
  if (s.startsWith('entity.name.function')) return 'entity.name.function';
  if (s.startsWith('entity.name.type')) return 'entity.name.type';
  if (s.startsWith('entity.other.property')) return 'entity.other.property';
  if (s.startsWith('variable.parameter')) return 'variable.parameter';
  if (s.startsWith('variable.language')) return 'variable.language';
  if (s.startsWith('variable.other')) return 'variable.other';
  if (s.startsWith('support.type')) return 'support.type';
  if (s.startsWith('support.class')) return 'support.class';
  if (s.startsWith('support.function')) return 'support.function';
  if (s.startsWith('support.variable')) return 'support.variable';
  if (s.startsWith('punctuation')) return 'punctuation';
  if (s.startsWith('meta')) return 'meta';
  if (s === 'source') return 'source';
  return s;
}

let exact = 0;
let category = 0;
let mismatch = 0;
let total = 0;

const mismatches: { text: string; line: number; official: string; dsl: string; offCat: string; dslCat: string }[] = [];

let oi = 0;
let di = 0;

while (oi < officialTokens.length && di < dslTokens.length) {
  const o = officialTokens[oi];
  const d = dslTokens[di];

  if (o.text !== d.text) {
    if (o.text.startsWith(d.text)) {
      di++;
      continue;
    }
    if (d.text.startsWith(o.text)) {
      oi++;
      continue;
    }
    oi++;
    di++;
    continue;
  }

  total++;
  const oNorm = normScope(o.innerScope);
  const dNorm = normScope(d.innerScope);

  if (oNorm === dNorm) {
    exact++;
  } else if (scopeCategory(o.innerScope) === scopeCategory(d.innerScope)) {
    category++;
  } else {
    mismatch++;
    mismatches.push({
      text: o.text,
      line: o.line,
      official: oNorm,
      dsl: dNorm,
      offCat: scopeCategory(o.innerScope),
      dslCat: scopeCategory(d.innerScope),
    });
  }

  oi++;
  di++;
}

console.log('═'.repeat(60));
console.log('Coverage Analysis: Monogram vs Official JavaScript Grammar');
console.log('═'.repeat(60));
console.log(`Test code: ${lines.length} lines, ${total} comparable tokens`);
console.log();
console.log(`  Exact scope match:    ${exact}/${total} (${(exact/total*100).toFixed(1)}%)`);
console.log(`  Category match:       ${category}/${total} (${(category/total*100).toFixed(1)}%)`);
console.log(`  Effective accuracy:   ${exact + category}/${total} (${((exact+category)/total*100).toFixed(1)}%)`);
console.log(`  Mismatch:             ${mismatch}/${total} (${(mismatch/total*100).toFixed(1)}%)`);
console.log();

// Visual equivalence: would a typical theme color them the same?
function isVisuallyEquivalent(offCat: string, dslCat: string, offScope: string, dslScope: string): boolean {
  // meta ↔ punctuation: brackets/braces in meta scopes vs punctuation — same color (none)
  if ((offCat === 'meta' && dslCat === 'punctuation') || (offCat === 'punctuation' && dslCat === 'meta')) return true;
  // String delimiter convention: punctuation.definition.string vs string.quoted — same string color
  if ((offCat === 'punctuation' && dslCat === 'string') || (offCat === 'string' && dslCat === 'punctuation')) return true;
  // keyword sub-types: storage.modifier ↔ keyword.other ↔ keyword.control for static/async/etc.
  if (offCat.startsWith('storage.modifier') && dslCat.startsWith('keyword')) return true;
  if (offCat.startsWith('keyword') && dslCat.startsWith('storage.modifier')) return true;
  if (offCat.startsWith('keyword.control') && dslCat.startsWith('storage.type')) return true;
  // entity.other.inherited-class ≈ entity.name.type — both type colors
  if (offScope.includes('inherited-class') && dslCat === 'entity.name.type') return true;
  // variable.other ↔ entity.other.property — similar in most themes
  if ((offCat === 'variable.other' && dslCat === 'entity.other.property') ||
      (offCat === 'entity.other.property' && dslCat === 'variable.other')) return true;
  // support.type ↔ constant.language for null/undefined/true/false (themes color both distinctly)
  if (offScope.includes('support.type.builtin') && (dslCat === 'constant.language')) return true;
  // keyword sub-categories: keyword.generator ↔ keyword.operator — same color in most themes
  if (offScope.startsWith('keyword.') && dslCat.startsWith('keyword.')) return true;
  if (offCat.startsWith('keyword.') && dslScope.startsWith('keyword.')) return true;
  // storage.type ↔ keyword for const/let/var/function/class — same color in most themes
  if ((offCat === 'storage.type' && dslCat.startsWith('keyword')) ||
      (offCat.startsWith('keyword') && dslCat === 'storage.type')) return true;
  return false;
}

let visualEquiv = 0;
const realMismatches: typeof mismatches = [];
for (const m of mismatches) {
  if (isVisuallyEquivalent(m.offCat, m.dslCat, m.official, m.dsl)) {
    visualEquiv++;
  } else {
    realMismatches.push(m);
  }
}

console.log(`  Visual equiv (diff scope, same color): ${visualEquiv}/${total} (${(visualEquiv/total*100).toFixed(1)}%)`);
console.log(`  Visual accuracy:  ${exact + category + visualEquiv}/${total} (${((exact+category+visualEquiv)/total*100).toFixed(1)}%)`);
console.log(`  Real gap:         ${realMismatches.length}/${total} (${(realMismatches.length/total*100).toFixed(1)}%)`);

if (realMismatches.length > 0) {
  const grouped = new Map<string, typeof mismatches>();
  for (const m of realMismatches) {
    const key = `${m.offCat} → ${m.dslCat}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }

  const sorted = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log('\n── Real Gaps (theme-visible differences) ──');
  for (const [key, items] of sorted) {
    console.log(`\n  ${key} (${items.length} tokens):`);
    for (const m of items.slice(0, 5)) {
      console.log(`    L${m.line}: "${m.text}"  official=${m.official}  dsl=${m.dsl}`);
    }
    if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
  }
}

console.log('\n' + '═'.repeat(60));
