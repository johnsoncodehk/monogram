// What a gate depends on, DERIVED from its source (not hand-written): the repository files its
// module graph reaches. From each file of the graph, starting at the gate's script:
//   - every relative import / export-from / dynamic import whose specifier is a string literal;
//   - every string literal (quoted or a template) that names a repository file: relative to the
//     file that holds it, or to the repository root (`'docs/X.md'`, `'./fixtures/calc.ts'`,
//     `'../javascript.ts'`); a template's `${…}` holes match any text, so
//     `${lang}.tmLanguage.json` depends on every `*.tmLanguage.json` it can name;
//   - every `.ts` file found that way is scanned in turn.
// Over-approximation is the safe direction (a gate runs that did not need to); the one way to
// miss an input is a path computed from pieces none of which is a literal naming the file. A
// gate that reads such a path names it in check.ts (`reads`), and test/gate-deps-sound.ts — the
// CI check of this derivation — traces the files every gate actually opens and fails when one
// is missing here.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

let files: string[] | undefined;
/** Every file of the repository (outside node_modules, .git, vendor checkouts and build output), repo-relative. */
export function repoFiles(): string[] {
  if (files) return files;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.claude' || e.name === 'target') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  walk(ROOT);
  return (files = out);
}

// The string literals of a module's CODE (comments skipped): quoted strings, and templates with
// each `${…}` hole as `${}`.
export function literals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const quoted = (q: string): string => {
    let t = '';
    i++;
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') { t += src[i + 1] ?? ''; i += 2; continue; }
      t += src[i++];
    }
    i++;
    return t;
  };
  const template = (): string => {
    let t = '';
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { t += src[i + 1] ?? ''; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const start = i;
        let depth = 1;
        while (i < n && depth > 0) {
          const ch = src[i];
          if (ch === '`') { template(); continue; }
          if (ch === "'" || ch === '"') { quoted(ch); continue; }
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        // a hole keeps its expression when it is a bare name (a constant edges() may know)
        const expr = src.slice(start, i - 1).trim();
        t += /^[A-Za-z_$][\w$]*$/.test(expr) ? '${' + expr + '}' : '${}';
        continue;
      }
      t += src[i++];
    }
    i++;
    return t;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === "'" || ch === '"') { out.push(quoted(ch)); continue; }
    if (ch === '`') { out.push(template()); continue; }
    i++;
  }
  return out;
}
const globRe = (pattern: string) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');

let selfExports: Map<string, string> | undefined;
/** The file a SELF-REFERENCE names (`'monogram/shape'`: the package's own name, resolved through
 * its package.json `exports`, as Node resolves it from inside the package). */
function selfReference(literal: string): string | undefined {
  if (!selfExports) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; exports?: Record<string, string> };
    selfExports = new Map(Object.entries(pkg.exports ?? {}).map(([k, v]) => [pkg.name + k.slice(1), relative(ROOT, resolve(ROOT, v)).split(sep).join('/')]));
  }
  return selfExports.get(literal);
}

export function candidates(literal: string, fromDir: string): string[] {
  const self = selfReference(literal);
  if (self) return [self];
  let text = literal.replace(/\$\{[^}]*\}/g, '*');
  if (!(/[./]/.test(text) || /^\*[A-Za-z]/.test(text)) || !/[A-Za-z]/.test(text) || text.length > 200 || text.includes('\n')) return [];
  const out: string[] = [];
  // A bare file-name SUFFIX (`'.ts'` in `name + '.ts'`, or `${dir}${name}.decisions.md`): the
  // files with that suffix at the repository root, or anywhere when the suffix is compound
  // (`.tmLanguage.json`, `.cst-match.ts`, `.decisions.md`: specific enough not to mean everything).
  const suffix = /^\**(\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/.exec(text);
  if (suffix) {
    const s = suffix[1]!, compound = s.indexOf('.', 1) > 0;
    for (const f of repoFiles()) if (f.endsWith(s) && (compound || !f.includes('/'))) out.push(f);
    return out;
  }
  // A leading hole is an absolute directory: one followed by `/` (`${dir}/x.md`) any directory of
  // the repository, one followed by a name (`${ROOT}x.ts`, ROOT ending in `/`) the repository root.
  let anyDir = false;
  if (text.startsWith('*/')) { anyDir = true; text = text.slice(2); }
  else if (text.startsWith('*')) text = text.replace(/^\*+/, '');
  const bases = anyDir || literal.startsWith('${') ? [''] : [fromDir, ''];
  for (const base of bases) {
    const p = relative(ROOT, resolve(ROOT, base, text)).split(sep).join('/');
    if (p.startsWith('..') || p === '') continue;
    if (p.includes('*') || anyDir) {
      if (!/\.[A-Za-z0-9]+$/.test(p)) continue;
      const re = anyDir ? new RegExp('(^|/)' + globRe(p).source.slice(1)) : globRe(p);
      for (const f of repoFiles()) if (re.test(f)) out.push(f);
      continue;
    }
    let st;
    // a module named without its extension (`'test/fixtures/envspec'` + `.ts`)
    try { st = statSync(join(ROOT, p)); } catch { if (!/\.[A-Za-z0-9]+$/.test(p) && existsSync(join(ROOT, p + '.ts'))) out.push(p + '.ts'); continue; }
    // a directory (read with readdirSync): every file under it
    if (st.isDirectory()) { if (p !== '.' && !p.startsWith('node_modules')) for (const f of repoFiles()) if (f.startsWith(p + '/')) out.push(f); }
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const memo = new Map<string, string[]>();
/** The files one file names (its edges in the dependency graph). */
export function edges(file: string): string[] {
  let e = memo.get(file);
  if (e) return e;
  e = [];
  if (/\.(ts|mts|js|mjs)$/.test(file)) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const dir = dirname(file);
    // a module's constants bound to one literal (`const OUT = `${ROOT}docs/decisions`;`) stand for
    // their value in a hole that names them
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/^(?:export )?const ([A-Za-z_$][\w$]*) = (['"`])((?:(?!\2)[^\\\n]|\\.)*)\2;?$/gm)) consts.set(m[1]!, m[3]!);
    // and one bound to a scratch directory (outside the repository) makes a path under it no input
    for (const m of src.matchAll(/^(?:export )?const ([A-Za-z_$][\w$]*) = (?:scratchDir|mkdtempSync|tmpdir)\(/gm)) consts.set(m[1]!, '\0');
    const expand = (lit: string, depth = 0): string => (depth > 3 ? lit : lit.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (h, name: string) => (consts.has(name) ? expand(consts.get(name)!, depth + 1) : '${}')));
    for (const lit of literals(src)) { const x = expand(lit); if (!x.includes('\0')) e.push(...candidates(x, dir)); }
    // a name every binding of which is a scratch directory (`const dir = scratchDir('nl')`, at any
    // depth): a path joined onto it is outside the repository
    const bound = new Map<string, boolean>();
    for (const m of src.matchAll(/^\s*(?:export )?(?:const|let) ([A-Za-z_$][\w$]*) = (.*)$/gm)) bound.set(m[1]!, (bound.get(m[1]!) ?? true) && /^(?:scratchDir|mkdtempSync|tmpdir)\(/.test(m[2]!));
    // a bare directory name joined onto a path (`join(ROOT, 'src')`): every file under it
    for (const m of src.matchAll(/\b(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)?[^()]*?['"]([A-Za-z][\w-]*)['"]/g)) {
      if (m[1] && bound.get(m[1])) continue;
      const d = m[2]!;
      for (const base of [dir, '']) {
        const p = base ? `${base}/${d}` : d;
        try { if (statSync(join(ROOT, p)).isDirectory()) for (const f of repoFiles()) if (f.startsWith(p + '/')) e.push(f); } catch { /* not a directory */ }
      }
    }
  }
  memo.set(file, (e = [...new Set(e)]));
  return e;
}

/** The repository files a gate's script reaches (itself included), plus its declared `reads`. */
export function gateDeps(script: string, reads: string[] = []): Set<string> {
  const { common, targets } = gateTargetDeps(script, reads);
  for (const t of targets.values()) for (const f of t) common.add(f);
  return common;
}

// Each emit target's module: what it reaches is that target's code. src/target.ts (the core) imports
// none of them, so a gate of one target reaches one of them (src/emit.ts, which re-exports every
// target, reaches all four: a gate that imports it depends on every target).
export const TARGET_ROOTS: Record<string, string> = { js: 'src/emit-parser.ts', ts: 'src/target-ts.ts', go: 'src/target-go.ts', rust: 'src/target-rust.ts' };
const ROOT_TARGET = new Map(Object.entries(TARGET_ROOTS).map(([t, f]) => [f, t]));
const closure = (from: string[], stop: (f: string) => boolean = () => false): Set<string> => {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!stop(f)) stack.push(...edges(f));
  }
  return seen;
};
/**
 * A gate's inputs split by target: `common` = what its script reaches without entering a target's
 * module (the target roots it names included), `targets` = for each target root it reaches, what
 * that root reaches. A change that touches no common file and only the files of targets T can
 * change only what the gate checks of T: a gate that runs one target at a time (the entry's
 * `targets: true` in check.ts) runs with CHECK_TARGETS=T.
 */
export function gateTargetDeps(script: string, reads: string[] = []): { common: Set<string>; targets: Map<string, Set<string>> } {
  const isRoot = (f: string) => ROOT_TARGET.has(f);
  const reached = closure([script, ...reads.flatMap((r) => candidates(r, ''))], isRoot);
  const targets = new Map<string, Set<string>>();
  for (const f of reached) if (isRoot(f)) targets.set(ROOT_TARGET.get(f)!, closure([f]));
  const common = new Set([...reached].filter((f) => !isRoot(f)));
  return { common, targets };
}
