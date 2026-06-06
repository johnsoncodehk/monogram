// redcmd-tm-diagnostics.ts -- focused CLI guard for the RedCMD TextMate diagnostics that
// reported issue #12 (`TextMate(include)` / `TextMate(dead)`) plus the TextMate 2.0
// Onigmo regex compatibility diagnostic. The upstream extension is VS Code-bound, so this
// test mirrors the relevant JSON-data subset and fingerprints the vendored source that
// defines the user-facing diagnostics.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as Onigmo from 'vscode-onigmo';

type JsonRecord = Record<string, unknown>;
type TextMateRegexKey = 'match' | 'begin' | 'end' | 'while';

type OnigmoBinding = {
  UTF8ToString(ptr: number): string;
  _getLastOnigError(): number;
};

type OnigmoScannerWithBinding = Onigmo.OnigScanner & {
  readonly _onigBinding?: OnigmoBinding;
};

type Diagnostic = {
  file: string;
  path: string;
  source: 'TextMate';
  code: 'include' | 'dead' | 'Onigmo';
  severity: 'warning' | 'error' | 'hint';
  message: string;
};

const upstreamSubmodule = 'vendor/RedCMD-TmLanguage-Syntax-Highlighter';
const upstreamDiagnostics = `${upstreamSubmodule}/src/DiagnosticCollection.ts`;
const textmateRegexKeys = new Set<string>(['match', 'begin', 'end', 'while']);
const require = createRequire(import.meta.url);
const textmateOnigmo = require('vscode-onigmo') as typeof Onigmo;

function assertUpstreamDiagnosticFingerprint(): void {
  if (!existsSync(upstreamDiagnostics)) {
    throw new Error(`Missing RedCMD diagnostics submodule. Run: git submodule update --init ${upstreamSubmodule}`);
  }
  const source = readFileSync(upstreamDiagnostics, 'utf8');
  const required = [
    'function diagnosticsBrokenIncludes',
    'function diagnosticsRegularExpressionErrors',
    "Cannot find repo name '${text}'",
    'The entire parent rule is nullified because all "#includes" failed.',
    'Regex incompatible with TextMate 2.0',
    "source: 'TextMate'",
    "code: 'include'",
    "code: 'dead'",
    "code: 'Onigmo'",
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length) throw new Error(`RedCMD diagnostics fingerprint changed; missing: ${missing.join(', ')}`);
}

async function loadOnigmo(): Promise<void> {
  const wasmPath = join(dirname(require.resolve('vscode-onigmo')), 'onigmo.wasm');
  await textmateOnigmo.loadWASM(readFileSync(wasmPath));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onigmoError(pattern: string): string | undefined {
  let scanner: OnigmoScannerWithBinding | undefined;
  try {
    scanner = new textmateOnigmo.OnigScanner([pattern]) as OnigmoScannerWithBinding;
    const binding = scanner._onigBinding;
    const lastError = binding?.UTF8ToString(binding._getLastOnigError()) ?? '';
    return normalizeOnigmoError(lastError);
  }
  catch (error: unknown) {
    return normalizeOnigmoError(error instanceof Error ? error.message : String(error));
  }
  finally {
    scanner?.dispose();
  }
}

function normalizeOnigmoError(error: string): string | undefined {
  const message = error.replace(/^Error: /, '').replace(/^undefined error code$/, '').trim();
  return message || undefined;
}

function countCapturingGroups(pattern: string): number {
  let count = 0;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (char !== '(' || inCharacterClass) continue;

    const next = pattern[index + 1];
    if (next !== '?') {
      count++;
      continue;
    }

    const marker = pattern[index + 2];
    if (marker === '<') {
      const lookbehindMarker = pattern[index + 3];
      if (lookbehindMarker !== '=' && lookbehindMarker !== '!') count++;
    }
    else if (marker === "'") {
      count++;
    }
  }

  return count;
}

function replaceBeginBackreferencesForTextMate(pattern: string, begin: string | undefined): string {
  if (!begin || !/\\[0-9]/.test(pattern)) return pattern;
  const captureCount = countCapturingGroups(begin);
  return pattern.replace(/\\\\|\\([0-9])/g, (match, digit: string | undefined) => {
    if (!digit) return match;
    const index = Number(digit);
    return index > 0 && index <= captureCount ? '' : match;
  });
}

function onigmoDiagnostic(file: string, path: string, pattern: string): Diagnostic | undefined {
  const error = onigmoError(pattern);
  if (!error) return;
  return {
    file,
    path,
    source: 'TextMate',
    code: 'Onigmo',
    severity: 'warning',
    message: `Regex incompatible with TextMate 2.0 (Onigmo v5.13.5)\n${error}`,
  };
}

function repositoryKeys(rule: JsonRecord): Set<string> {
  const repository = rule.repository;
  return isRecord(repository) ? new Set(Object.keys(repository)) : new Set();
}

function visibleRepositories(rootRepository: Set<string>, repositoryStack: Set<string>[]): Set<string> {
  return new Set([...rootRepository, ...repositoryStack.flatMap((items) => [...items])]);
}

function missingInclude(rule: JsonRecord, visible: Set<string>): string | undefined {
  const include = rule.include;
  if (typeof include !== 'string' || !include.startsWith('#') || include.length <= 1) return;
  const name = include.slice(1);
  return visible.has(name) ? undefined : name;
}

function includeDiagnostic(file: string, path: string, name: string, severity: 'warning' | 'error'): Diagnostic {
  return {
    file,
    path,
    source: 'TextMate',
    code: 'include',
    severity,
    message: `Cannot find repo name '${name}'`,
  };
}

function shouldReportDeadRule(rule: JsonRecord, path: string): boolean {
  return path !== '$' && !('match' in rule) && !('begin' in rule) && !('include' in rule);
}

function collectDiagnostics(file: string, grammar: JsonRecord): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const rootRepository = repositoryKeys(grammar);

  function walk(value: unknown, path: string, repositoryStack: Set<string>[]): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, repositoryStack));
      return;
    }
    if (!isRecord(value)) return;

    const localRepositories = repositoryKeys(value);
    const nextStack = localRepositories.size ? [...repositoryStack, localRepositories] : repositoryStack;
    const visible = visibleRepositories(rootRepository, nextStack);
    const missing = missingInclude(value, visible);
    if (missing) diagnostics.push(includeDiagnostic(file, path, missing, 'warning'));

    for (const key of textmateRegexKeys) {
      const pattern = value[key];
      if (typeof pattern !== 'string') continue;
      const begin = key === 'end' || key === 'while' ? value.begin : undefined;
      const replacedPattern = replaceBeginBackreferencesForTextMate(pattern, typeof begin === 'string' ? begin : undefined);
      const diagnostic = onigmoDiagnostic(file, `${path}.${key}`, replacedPattern);
      if (diagnostic) diagnostics.push(diagnostic);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'patterns' && Array.isArray(child)) {
        walkPatterns(value, child, `${path}.patterns`, nextStack, path);
      }
      else {
        walk(child, `${path}.${key}`, nextStack);
      }
    }
  }

  function walkPatterns(parentRule: JsonRecord, patterns: unknown[], path: string, repositoryStack: Set<string>[], parentPath: string): void {
    const deferredIncludes: Diagnostic[] = [];
    let invalidIncludeOnlyCount = 0;

    patterns.forEach((pattern, index) => {
      if (!isRecord(pattern)) {
        walk(pattern, `${path}[${index}]`, repositoryStack);
        return;
      }

      const patternRepositories = repositoryKeys(pattern);
      const patternStack = patternRepositories.size ? [...repositoryStack, patternRepositories] : repositoryStack;
      const missing = missingInclude(pattern, visibleRepositories(rootRepository, patternStack));
      const includeOnly = missing && !('match' in pattern) && !('begin' in pattern);
      if (includeOnly) {
        invalidIncludeOnlyCount++;
        deferredIncludes.push(includeDiagnostic(file, `${path}[${index}]`, missing, 'warning'));
        return;
      }

      walk(pattern, `${path}[${index}]`, repositoryStack);
    });

    if (!deferredIncludes.length) return;
    const allPatternsFailed = invalidIncludeOnlyCount === patterns.length;
    diagnostics.push(...deferredIncludes.map((diagnostic) => ({
      ...diagnostic,
      severity: allPatternsFailed ? 'error' as const : diagnostic.severity,
    })));
    if (allPatternsFailed && shouldReportDeadRule(parentRule, parentPath)) {
      diagnostics.push({
        file,
        path: parentPath,
        source: 'TextMate',
        code: 'dead',
        severity: 'hint',
        message: 'The entire parent rule is nullified because all "#includes" failed.',
      });
    }
  }

  walk(grammar, '$', []);
  return diagnostics;
}

function assertDetectorSelfTest(): void {
  const grammar = {
    scopeName: 'source.self-test',
    patterns: [{ include: '#bad' }],
    repository: {
      bad: {
        patterns: [{ include: '#missing' }],
      },
    },
  };
  const diagnostics = collectDiagnostics('<self-test>', grammar);
  if (!diagnostics.some((diagnostic) => diagnostic.code === 'include' && diagnostic.severity === 'error')) {
    throw new Error('Self-test failed to report TextMate(include) for a missing repository include.');
  }
  if (!diagnostics.some((diagnostic) => diagnostic.code === 'dead')) {
    throw new Error('Self-test failed to report TextMate(dead) for a nullified parent rule.');
  }
  const onigmoDiagnostics = collectDiagnostics('<self-test>', {
    scopeName: 'source.regex-self-test',
    patterns: [{ include: '#bad-regex' }],
    repository: {
      'bad-regex': {
        begin: '(?<=(?:^|=)\\s*!*)/',
        end: '/',
      },
    },
  });
  if (!onigmoDiagnostics.some((diagnostic) => diagnostic.code === 'Onigmo')) {
    throw new Error('Self-test failed to report TextMate(Onigmo) for an incompatible regex.');
  }
}

assertUpstreamDiagnosticFingerprint();
await loadOnigmo();
assertDetectorSelfTest();

const grammarFiles = readdirSync(process.cwd())
  .filter((name) => name.endsWith('.tmLanguage.json'))
  .sort();

const failures = grammarFiles.flatMap((file) => {
  const grammar = JSON.parse(readFileSync(join(process.cwd(), file), 'utf8')) as JsonRecord;
  return collectDiagnostics(file, grammar);
});

if (failures.length) {
  console.error(`RedCMD TextMate diagnostics found ${failures.length} issue(s):`);
  for (const diagnostic of failures) {
    console.error(`  ${diagnostic.file} ${diagnostic.path} ${diagnostic.source}(${diagnostic.code}) ${diagnostic.severity}: ${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(`RedCMD TextMate diagnostics: ${grammarFiles.length} top-level grammars clean.`);