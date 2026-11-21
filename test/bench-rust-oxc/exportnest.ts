// node exportnest.ts <out>: the minimal input for the nested-`export` cost — 5,000 one-line
// statements inside four nested `export namespace` blocks (226,766 bytes). Two alternatives of
// Decl each parse an `export`-led declaration in full, so every level of `export` nesting
// doubles the work of a parser that tries both.
import { writeFileSync } from 'node:fs';
let src = Array.from({ length: 5000 }, (_, i) => `  const v${i} = f(${i}, [a, b], { k: ${i} });`).join('\n');
for (let i = 0; i < 4; i++) src = `export namespace N${i} {\n${src}\n}`;
writeFileSync(process.argv[2]!, src + '\n');
