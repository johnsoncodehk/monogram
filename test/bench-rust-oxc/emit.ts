// node emit.ts <monogram source tree> <out.rs>: emitParser(typescript.ts, rustTarget) from that tree.
import { writeFileSync } from 'node:fs';
const [root, out] = process.argv.slice(2);
const { emitParser, rustTarget } = await import(root + '/src/emit.ts');
const grammar = (await import(root + '/typescript.ts')).default;
writeFileSync(out, emitParser(grammar, rustTarget));
