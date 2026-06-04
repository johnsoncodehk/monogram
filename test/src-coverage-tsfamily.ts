// src-coverage-tsfamily.ts — shared factory for the TypeScript-family dialects (the VS Code
// built-in languages TypeScript / JavaScript / JSX / TSX). All four share ONE official
// parser — typescript.js — so the only per-dialect knobs are: the ts.ScriptKind fed to the
// oracle, the Monogram grammar, and the corpus. The accept/reject oracle, the parser/scanner
// name filter, and the confusion-matrix header are identical, so they live here and the four
// entrypoints (src-coverage-{ts,js,jsx,tsx}.ts) are thin.
//
// Oracle = accept/reject: official accept iff ts.createSourceFile(...scriptKind).parseDiagnostics
// is empty; Monogram accept iff createParser(dialectGrammar).parse(code) doesn't throw.
// See ./src-coverage.ts for the coverage harness + metric definitions.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { createParser } from '../src/gen-parser.ts';
import type { Adapter, AgreeResult, CorpusItem } from './src-coverage.ts';

export interface TsFamilyCase { file: string; code: string }

// `// @filename:` marks a multi-file fixture — exclude (the harness feeds whole files).
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

function walk(d: string, exts: string[]): string[] {
  let o: string[] = [];
  let entries: ReturnType<typeof readdirSync> = [] as any;
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return o; }
  for (const e of entries) {
    const f = join(d, e.name);
    if (e.isDirectory()) o = o.concat(walk(f, exts));
    else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}

// Deterministic, structurally-spread subset: stride-sample the sorted list so the whole tree
// is represented, not just the first N. `all`/Infinity = everything.
function pick<T>(items: T[], n: number): T[] {
  if (!isFinite(n) || n >= items.length) return items;
  const out: T[] = [];
  const stride = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * stride)]);
  return out;
}

// SUBSET from argv/env (default 400; `all` = full). Shared by every TS-family entrypoint.
export function subsetArg(def = 400): number {
  const a = process.argv[2];
  return a === 'all' ? Infinity : Number(a ?? process.env.SUBSET ?? def);
}

// Walk `roots` (absolute dirs) for `exts`, drop .d.ts + multi-file fixtures, stride-sample.
export function walkCorpus(roots: string[], exts: string[], subset: number): TsFamilyCase[] {
  const files: string[] = [];
  for (const r of roots) files.push(...walk(r, exts));
  files.sort();
  const cases: TsFamilyCase[] = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    if (!isMulti(code)) cases.push({ file: f, code });
  }
  return pick(cases, subset);
}

// parser/scanner-only name filter: the functions in typescript.js that make *syntactic*
// decisions. Anchored ^ so it matches function NAMES not substrings; excludes the *Object
// AST-node wrappers (TokenObject/NodeObject/SourceFileObject).
const PARSER_NAME_RE =
  /^(parse|reParse|reScan|scan(?!ner)|nextToken|tryParse|lookAhead|speculationHelper|isStartOf|isListElement|isListTerminator|canParseSemicolon|canFollow|nextTokenIs|nextTokenCan|parseList|parseDelimitedList)/;

const KIND_EXT: Record<number, string> = {
  [ts.ScriptKind.TS]: 't.ts', [ts.ScriptKind.TSX]: 't.tsx',
  [ts.ScriptKind.JS]: 't.js', [ts.ScriptKind.JSX]: 't.jsx',
};

export interface TsFamilyOpts {
  name: string;            // display name, e.g. "JavaScript (.js)"
  scriptKind: ts.ScriptKind;
  grammar: unknown;        // the Monogram dialect grammar (default export of javascript.ts etc.)
  corpus: TsFamilyCase[];
  originBase?: string;     // strip this prefix from file paths in the disagree ledger examples
}

export function tsFamilyAdapter(opts: TsFamilyOpts): Adapter {
  const { parse } = createParser(opts.grammar as any);
  const fileName = KIND_EXT[opts.scriptKind] ?? 't.ts';
  const strip = opts.originBase ? (f: string) => f.replace(opts.originBase + '/', '') : (f: string) => f;

  let officialThrew = 0;
  const officialAccepts = (code: string): boolean => {
    // The accept/reject oracle (ts.createSourceFile). Guard the rare TS Debug.assert throw (a TS parser bug,
    // not an accept) → count as reject; the partial parse still contributes coverage.
    try {
      const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, opts.scriptKind);
      return (((sf as any).parseDiagnostics as unknown[] | undefined)?.length ?? 0) === 0;
    } catch { officialThrew++; return false; }
  };
  const monogramAccepts = (code: string): boolean => { try { parse(code); return true; } catch { return false; } };

  return {
    name: opts.name,
    oracle: 'accept/reject (bidirectional)',
    urlMatch: (url) => url.includes('typescript/lib/typescript.js'),
    loadCorpus: (): CorpusItem[] => opts.corpus.map((c) => ({ code: c.code, origin: strip(c.file) })),
    warmup: () => {
      for (const w of ['const x=1;', 'class C{m(){}}', 'function*g(){yield 1}', 'x=>x', 'a?.b'])
        ts.createSourceFile(fileName, w, ts.ScriptTarget.Latest, true, opts.scriptKind);
    },
    runOfficial: (code) => ({ accept: officialAccepts(code) }), // the measured ts.createSourceFile
    agree: (code, official): AgreeResult => {
      const o = (official as { accept: boolean }).accept;
      const m = monogramAccepts(code);
      return { agree: o === m, officialAccept: o, monoAccept: m };
    },
    denominators: [
      { label: 'all of typescript.js', keep: () => true },
      { label: 'parser/scanner-named functions only', keep: (p) => PARSER_NAME_RE.test(p.fnName) },
    ],
    renderHeader: (results) => {
      let TP = 0, FN = 0, FP = 0, TN = 0;
      for (const r of results) {
        const o = r.officialAccept as boolean, m = r.monoAccept as boolean;
        if (o && m) TP++; else if (o && !m) FN++; else if (!o && m) FP++; else TN++;
      }
      const total = TP + FN + FP + TN || 1;
      console.log(`  confusion: TP=${TP} (both accept)  FN=${FN} (official accept, we reject)  FP=${FP} (official reject, we accept)  TN=${TN} (both reject)`);
      console.log(`  bidirectional agree: ${((100 * (TP + TN)) / total).toFixed(2)}%`);
      if (officialThrew) console.log(`  caveat: official parser threw on ${officialThrew} file(s) — counted as reject (TS Debug.assert edge cases)`);
    },
  };
}
