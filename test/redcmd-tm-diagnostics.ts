// redcmd-tm-diagnostics.ts -- focused CLI guard for the RedCMD TextMate diagnostics that
// reported issue #12 (`TextMate(include)` / `TextMate(dead)`). The upstream extension is
// VS Code-bound, so this test mirrors the broken-include/dead-rule subset over JSON data and
// fingerprints the vendored source that defines the user-facing diagnostics.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

type Diagnostic = {
  file: string;
  path: string;
  source: 'TextMate';
  code: 'include' | 'dead';
  severity: 'warning' | 'error' | 'hint';
  message: string;
};

const upstreamSubmodule = 'vendor/RedCMD-TmLanguage-Syntax-Highlighter';
const upstreamDiagnostics = `${upstreamSubmodule}/src/DiagnosticCollection.ts`;

function assertUpstreamDiagnosticFingerprint(): void {
  if (!existsSync(upstreamDiagnostics)) {
    throw new Error(`Missing RedCMD diagnostics submodule. Run: git submodule update --init ${upstreamSubmodule}`);
  }
  const source = readFileSync(upstreamDiagnostics, 'utf8');
  const required = [
    'function diagnosticsBrokenIncludes',
    "Cannot find repo name '${text}'",
    'The entire parent rule is nullified because all "#includes" failed.',
    "source: 'TextMate'",
    "code: 'include'",
    "code: 'dead'",
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length) throw new Error(`RedCMD diagnostics fingerprint changed; missing: ${missing.join(', ')}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
}

assertUpstreamDiagnosticFingerprint();
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