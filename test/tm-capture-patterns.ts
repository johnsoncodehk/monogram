// tm-capture-patterns.ts — counts, per committed `.tmLanguage.json`, the captures that carry
// `patterns` (a capture re-tokenized by nested rules). VS Code accepts them; Sublime Text's
// TextMate loader rejects a grammar that has any, so every such capture is an editor the
// artifact does not load in. REPORT-ONLY in the sense that no count is a target: the gate pins
// today's counts so a change that adds one is visible and a change that removes one must
// lower the pinned number in the same commit (the record moves with the generator).
//   node test/tm-capture-patterns.ts            check against the pinned counts
//   node test/tm-capture-patterns.ts --list     also print every capture path
import { readFileSync } from 'node:fs';

// Pinned on master 86f6530. Where they come from:
//   javascriptreact / typescriptreact: dotted JSX tag names re-tokenized inside the tag-name
//     capture (gen-tm `generateJsxPatterns`, the member-expression tag patterns);
//   html: attribute-value embeds and tag-name captures of the markup generator;
//   yaml: block-scalar headers, keys and flow-node captures of the indent generator.
const PINNED: Record<string, number> = {
  'javascript.tmLanguage.json': 0,
  'typescript.tmLanguage.json': 0,
  'javascriptreact.tmLanguage.json': 5,
  'typescriptreact.tmLanguage.json': 5,
  'html.tmLanguage.json': 32,
  'html-derivative.tmLanguage.json': 0,
  'yaml.tmLanguage.json': 22,
};

export function capturesWithPatterns(grammar: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown, at: string): void => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (/^(?:begin|end|while)?[cC]aptures$/.test(k) && v && typeof v === 'object')
        for (const [g, c] of Object.entries(v)) if (c && typeof c === 'object' && 'patterns' in c) out.push(`${at}/${k}/${g}`);
      walk(v, `${at}/${k}`);
    }
  };
  walk(grammar, '');
  return out;
}

if (import.meta.main) {
  const list = process.argv.includes('--list');
  let bad = 0;
  for (const [file, pinned] of Object.entries(PINNED)) {
    const found = capturesWithPatterns(JSON.parse(readFileSync(file, 'utf8')));
    const ok = found.length === pinned;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${file}: ${found.length} capture(s) with patterns${ok ? '' : ` (pinned ${pinned}: ${found.length > pinned ? 'a change ADDED some' : 'lower the pinned count'})`}`);
    if (list || !ok) for (const p of found) console.log('    ' + p);
  }
  const total = Object.keys(PINNED).reduce((s, f) => s + capturesWithPatterns(JSON.parse(readFileSync(f, 'utf8'))).length, 0);
  console.log(`\n${total} capture(s) with patterns across ${Object.keys(PINNED).length} grammars${bad ? '' : ' ✓ (matches the record)'}`);
  if (bad) process.exit(1);
}
