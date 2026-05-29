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

const officialPath = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json';
const dslPath = 'examples/typescript.tmLanguage.json';

const officialContent = readFileSync(officialPath, 'utf-8');
const dslContent = readFileSync(dslPath, 'utf-8');

const officialRegistry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.ts') return parseRawGrammar(officialContent, 'TypeScript.tmLanguage.json');
    return null;
  },
});

const dslRegistry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.typescript') return parseRawGrammar(dslContent, 'typescript.tmLanguage.json');
    return null;
  },
});

const officialGrammar = await officialRegistry.loadGrammar('source.ts');
const dslGrammar = await dslRegistry.loadGrammar('source.typescript');
if (!officialGrammar || !dslGrammar) throw new Error('Failed to load grammars');

const testCode = `
import { readFileSync } from 'node:fs';
import type { Config } from './types';

const MAX_RETRIES = 3;
let counter: number = 0;

interface ILogger<T extends object> {
  log(message: string, level?: number): void;
  format(data: T): string;
}

type Nullable<T> = T | null | undefined;
type Result<T, E extends Error = Error> = { ok: true; value: T } | { ok: false; error: E };

class EventEmitter<T extends Record<string, unknown>> implements ILogger<T> {
  private listeners: Map<string, Set<Function>> = new Map();
  readonly #id: number;

  constructor(public name: string, private maxListeners: number = 10) {
    this.#id = counter++;
  }

  async emit<K extends keyof T>(event: K, ...args: T[K][]): Promise<void> {
    const handlers = this.listeners.get(event as string) ?? new Set();
    for (const handler of handlers) {
      await handler(...args);
    }
  }

  log(message: string, level: number = 0): void {
    console.log(\`[\${this.name}] \${message}\`);
  }

  format(data: T): string {
    return JSON.stringify(data, null, 2);
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, s) => sum + s.size, 0);
  }

  static create<T extends Record<string, unknown>>(name: string): EventEmitter<T> {
    return new EventEmitter<T>(name);
  }
}

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

function createLogger<T extends object>(config: Config): ILogger<T> {
  const { verbose = false, prefix } = config;
  const level = verbose ? LogLevel.DEBUG : LogLevel.INFO;

  return {
    log: (message: string, lvl: number = level) => {
      if (lvl >= level) {
        console.log(\`\${prefix}: \${message}\`);
      }
    },
    format: (data: T): string => JSON.stringify(data),
  };
}

async function* fetchPages<T>(
  url: string,
  transform: (raw: unknown) => T
): AsyncGenerator<T[], void, undefined> {
  let page = 1;
  while (true) {
    const response = await fetch(\`\${url}?page=\${page}\`);
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    const data: unknown[] = await response.json();
    if (data.length === 0) break;
    yield data.map(transform);
    page++;
  }
}

export { EventEmitter, createLogger, fetchPages, LogLevel };
export type { ILogger, Nullable, Result };

declare module 'express' {
  interface Request {
    user?: { id: string; role: string };
  }
}

const numbers = [1, 2, 3];
const doubled = numbers.map(x => x * 2);
const first = numbers.find((n): n is number => n > 0);

const regex = /^https?:\\/\\/[\\w.-]+\\.[a-z]{2,}/gi;
const hex = 0xFF_FF;
const binary = 0b1010_1010;
const big = 100_000n;

try {
  const result = await fetchPages<string>('/api/items', (raw) => String(raw));
  for await (const page of result) {
    console.log(page);
  }
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  }
} finally {
  console.log('done');
}
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
    .replace(/\.ts$/, '')
    .replace(/\.tsx$/, '')
    .replace(/\.typescript$/, '')
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
console.log('Coverage Analysis: Monogram vs Official TypeScript Grammar');
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
  // keyword sub-types: storage.modifier ↔ keyword.other ↔ keyword.control for extends/implements/type
  if (offCat.startsWith('storage.modifier') && dslCat.startsWith('keyword')) return true;
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
