// The createLexer runtime as SOURCE TEXT, for emitted parsers whose grammar has no specialized
// lexer (indent / newline / markup state machines stay data-driven — see emit-lexer.ts). The
// emitted module carries this text instead of importing it, so it loads with no dependency on
// monogram and no path baked in from the machine that emitted it.
//
// The sources stay the single copy: the closure is computed by following gen-lexer.ts's
// relative imports, and every file is included verbatim minus its module syntax. Anything the
// transform cannot carry faithfully (a non-relative import, a re-export, `export default`,
// `import.meta`, a top-level name declared by two files) throws at emit time instead of
// producing a module that breaks at load time.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'gen-lexer.ts';

const IMPORT_DECL = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+'([^']+)';[ \t]*$/gm;
const EXPORT_DECL = /^export\s+(?=(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\b)/gm;
const TOP_LEVEL_NAME = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;

interface RuntimeFile { name: string; body: string; deps: string[] }

function readRuntimeFile(name: string): RuntimeFile {
  const text = readFileSync(resolve(SRC_DIR, name), 'utf8');
  const deps: string[] = [];
  const body = text.replace(IMPORT_DECL, (_m, spec: string) => {
    if (!spec.startsWith('./') || spec.includes('/', 2)) throw new Error(`inline runtime: src/${name} imports ${JSON.stringify(spec)} — only sibling modules can be inlined`);
    deps.push(basename(spec));
    return '';
  }).replace(EXPORT_DECL, '');
  for (const [re, what] of [[/^\s*import\b/m, 'an import'], [/^\s*export\b/m, 'an export'], [/\bimport\.meta\b|\brequire\s*\(|(?:[=(,]|\bawait|\breturn)\s*import\s*\(/, 'a dynamic module reference']] as const) {
    if (re.test(body)) throw new Error(`inline runtime: src/${name} still has ${what} after the transform — extend inline-runtime.ts or restructure the source`);
  }
  return { name, body, deps };
}

// Dependencies first, so every declaration precedes the code that names it at load time.
function runtimeClosure(): RuntimeFile[] {
  const order: RuntimeFile[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const file = readRuntimeFile(name);
    for (const d of file.deps) visit(d);
    order.push(file);
  };
  visit(ENTRY);
  return order;
}

/** The runtime closure as one block that binds a module-local `createLexer` and nothing else. */
export function inlineLexerRuntime(): string {
  const files = runtimeClosure();
  const owner = new Map<string, string>();
  for (const f of files) {
    for (const m of f.body.matchAll(TOP_LEVEL_NAME)) {
      const prev = owner.get(m[1]);
      if (prev !== undefined && prev !== f.name) throw new Error(`inline runtime: top-level name ${m[1]} is declared in both src/${prev} and src/${f.name}`);
      owner.set(m[1], f.name);
    }
  }
  return [
    `// ── createLexer runtime (inlined from monogram ${files.map(f => 'src/' + f.name).join(', ')}) ──`,
    `const createLexer = (() => {`,
    ...files.map(f => `// ── src/${f.name} ──\n${f.body}`),
    `return createLexer;`,
    `})();`,
  ].join('\n');
}
